import { Hono } from 'hono';
import { db } from '../db/index.js';
import { notes, attachments, tombstones } from '../db/schema.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { encrypt, decrypt } from '../crypto.js';
import { htmlToPlaintext } from '../html-to-text.js';
import {
  s3Client,
  presignPut,
  generateR2Key,
  getR2Object,
} from '../r2.js';
import { rateLimit } from '../middleware/ratelimit.js';
import {
  bodySizeLimit,
  BACKUP_IMPORT_BYTES,
} from '../middleware/body-limit.js';
import type {
  BackupPayloadV2,
  BackupAttachmentV2,
  BackupImportResponse,
  NoteDTO,
} from '@mindleaf/shared';
import { isAllowedUploadMime, uuidSchema } from '../lib/upload-validation.js';
import type { AppEnv } from '../env.js';

export const backupRoutes = new Hono<AppEnv>();

// Phase 10 — Per-route body-size override. The 5 MB global limit
// applies to most API routes (auth, CRUD JSON). Importing a backup
// is the legitimate exception; the transport ceiling is 150 MB, while
// the handler rejects files above its safer 100 MB parsing budget.
// Export path does not need an override — it returns JSON, not
// receives it, so its output size matters (we cap at 110 MB binary
// in MAX_EXPORT_TOTAL_BYTES during R2 fan-out).
backupRoutes.use('/import/full', bodySizeLimit(BACKUP_IMPORT_BYTES));

/**
 * Phase 7 — Bulk Export/Import via backend.
 *
 *  POST /api/backup/export/full
 *    Returns a single `BackupPayloadV2` JSON containing every active
 *    note (content server-side decrypted) and every attachment with
 *    inline base64. Backward-compatible with the byte format
 *    `apps/web/src/lib/notes-io.ts` writes — a cloud-exported
 *    `.treenote` and a local-exported `.treenote` are interchangeable
 *    on re-import.
 *
 *  POST /api/backup/import/full  (multipart/form-data with `file=<.treenote>`)
 *    Parses the backup, re-encrypts each note's content with the
 *    server's master key (idempotent on note id), and creates
 *    attachment rows in `pending` R2-upload state. Returns presigned
 *    PUT URLs so the client uploads each blob directly to R2 — the
 *    backend never proxies attachment bytes (keeps VPS bandwidth out
 *    of the import path).
 */

// --- Concurrently-limited R2 fetcher ---
// The export path can do `attachments.length` GET calls to R2. Doing
// them in sequence would be O(N * RTT); doing them with unbounded
// parallelism can OOM the backend when the user has thousands of
// attachments. We cap concurrency at 4: enough to elicit HTTP/2
// pipelining benefits without spiking memory.

const CONCURRENCY = 4;

async function pMap<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx] as T, idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// ---------------------------------------------------------------------------
// POST /api/backup/export/full
// ---------------------------------------------------------------------------

function decryptRow(row: typeof notes.$inferSelect): string {
  if (!row.contentCt || !row.contentNonce) return '';
  return decrypt(row.contentCt, row.contentNonce);
}

function rowToNoteDTO(
  row: typeof notes.$inferSelect,
  content: string,
): NoteDTO {
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    content,
    isFolder: row.isFolder,
    isExpanded: row.isExpanded,
    orderIdx: row.orderIdx,
    tags: row.tags ?? [],
    deletedAt: row.deletedAt ? row.deletedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    version: row.version,
  };
}

backupRoutes.post(
  '/export/full',
  rateLimit({ key: 'export', requests: 5, windowMs: 60_000 }),
  async (c) => {
    // Pin to a non-null const so closures inside `pMap` see the
    // narrowed value — TS would otherwise widen `s3Client` back to
    // `S3Client | null` inside the async callback.
    const s3 = s3Client;
    if (!s3) {
      return c.json({ error: 'Object storage not configured' }, 503);
    }

    // Phase 7 budget: cap total export size at ~150 MB of inline
    // base64 (~110 MB binary). Past that a 1-core/1GB RAM VPS will
    // OOM holding the full payload before the response stream
    // finishes. Returning 413 lets the Sidebar fall back to the
    // smaller local-cache export.
    const MAX_EXPORT_TOTAL_BYTES = 150 * 1024 * 1024;
    let runningTotal = 0;
    let overBudget = false;

    // 1. Fetch all active notes (decrypted for export).
    const noteRows = await db
      .select()
      .from(notes)
      .where(eq(notes.isDeleted, false));
    const noteDtos = noteRows.map((r) =>
      rowToNoteDTO(r, decryptRow(r)),
    );

    // 2. Fetch all attachment rows (canonical metadata source for
    //    both locally-created and cloud-uploaded images).
    const attRows = await db.select().from(attachments);

    // 3. Download each attachment from R2 in parallel, capped at
    //    CONCURRENCY to keep the backend from OOMing on huge
    //    galleries. Skip rows without an `r2Key` (these were
    //    inserted but the client never completed upload — emit them
    //    with empty base64 so the export doesn't silently drop the
    //    note's image refs).
    const backupAttachments: BackupAttachmentV2[] = await pMap(
      attRows,
      async (a): Promise<BackupAttachmentV2> => {
        if (!a.r2Key) {
          return {
            id: a.id,
            noteId: a.noteId,
            mime: a.mime,
            name: a.name,
            createdAt: a.createdAt.getTime(),
            dataBase64: '',
          };
        }
        try {
          const out = await getR2Object(a.r2Key);
          // Stream the body into one Buffer. `out.Body` is a Node
          // Readable; collect into a buffer for base64.
          const chunks: Buffer[] = [];
          for await (const chunk of out.Body as AsyncIterable<Buffer>) {
            chunks.push(
              Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
            );
          }
          const buf = Buffer.concat(chunks);
          // Bail out early if the running total would push us past
          // the memory budget — surface to caller via 413 below.
          if (runningTotal + buf.length > MAX_EXPORT_TOTAL_BYTES) {
            overBudget = true;
            return {
              id: a.id,
              noteId: a.noteId,
              mime: a.mime,
              name: a.name,
              createdAt: a.createdAt.getTime(),
              dataBase64: '',
            };
          }
          runningTotal += buf.length;
          return {
            id: a.id,
            noteId: a.noteId,
            mime: a.mime,
            name: a.name,
            createdAt: a.createdAt.getTime(),
            dataBase64: buf.toString('base64'),
          };
        } catch (err) {
          console.error(
            `[export] Failed to fetch R2 object ${a.r2Key} for attachment ${a.id}:`,
            err,
          );
          // Emit an empty attachment so the import path on the
          // receiving side still has metadata — the image will be
          // missing visually but the note structure is intact.
          return {
            id: a.id,
            noteId: a.noteId,
            mime: a.mime,
            name: a.name,
            createdAt: a.createdAt.getTime(),
            dataBase64: '',
          };
        }
      },
      CONCURRENCY,
    );

    if (overBudget) {
      return c.json(
        {
          error:
            'Export exceeds 150 MB total attachment size. Use the local-cache export instead (sidebar download).',
        },
        413,
      );
    }

    const body: BackupPayloadV2 = {
      version: 2,
      notes: noteDtos,
      attachments: backupAttachments,
    };

    return c.json(body);
  },
);

// ---------------------------------------------------------------------------
// POST /api/backup/import/full   (multipart/form-data with `file=<.treenote>`)
// ---------------------------------------------------------------------------
//
// We accept the .treenote file as multipart/form-data (rather than raw
// JSON body) so the file upload slot is the standard browser primitive
// and we can keep the request under the platform's body-size limit.
//
// Flow:
//   1. Read the `file` field, parse JSON, structurally validate.
//   2. Re-encrypt every note's content with the master key, insert/
//      upsert each row by `id`. Re-encrypting is mandatory because
//      incoming content is plaintext from the .treenote file.
//   3. For each attachment, create a row with a fresh `r2Key` and
//      presign a PUT URL. The browser PUTs the blob after the 200.

const MAX_IMPORT_BYTES = 100 * 1024 * 1024; // 100 MB upper bound
const MAX_IMPORT_NOTES = 50_000;
const MAX_IMPORT_ATTACHMENTS = 50_000;

backupRoutes.post(
  '/import/full',
  rateLimit({ key: 'import', requests: 5, windowMs: 60_000 }),
  async (c) => {
    const s3 = s3Client;
    if (!s3) {
      return c.json({ error: 'Object storage not configured' }, 503);
    }

    const form = await c.req.formData().catch(() => null);
    if (!form) {
      return c.json({ error: 'Expected multipart/form-data body' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json(
        { error: 'Missing `file` field in multipart payload' },
        400,
      );
    }
    if (file.size > MAX_IMPORT_BYTES) {
      return c.json(
        { error: `Import too large. Max ${MAX_IMPORT_BYTES / 1024 / 1024} MB.` },
        413,
      );
    }

    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return c.json({ error: 'Backup file is not valid JSON' }, 400);
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return c.json(
        { error: 'Backup file is not a v2 BackupPayload object' },
        400,
      );
    }
    const obj = parsed as {
      version?: unknown;
      notes?: unknown;
      attachments?: unknown;
    };
    if (obj.version !== 2) {
      return c.json(
        { error: `Unsupported backup version: ${String(obj.version)}` },
        400,
      );
    }
    if (!Array.isArray(obj.notes)) {
      return c.json(
        { error: 'Backup `notes` field must be an array' },
        400,
      );
    }
    const rawNotes = obj.notes as unknown[];
    const rawAttachments = Array.isArray(obj.attachments)
      ? (obj.attachments as unknown[])
      : [];
    // Reject oversized arrays before any per-item database lookup. Also
    // reject duplicate IDs in one backup, since silently choosing one
    // payload would make the restore non-deterministic.
    if (rawNotes.length > MAX_IMPORT_NOTES) {
      return c.json({ error: `Too many notes. Max ${MAX_IMPORT_NOTES}.` }, 413);
    }
    if (rawAttachments.length > MAX_IMPORT_ATTACHMENTS) {
      return c.json(
        { error: `Too many attachments. Max ${MAX_IMPORT_ATTACHMENTS}.` },
        413,
      );
    }
    const noteIds = new Set<string>();
    for (const raw of rawNotes) {
      if (!raw || typeof raw !== 'object') {
        return c.json({ error: 'Backup contains an invalid note record' }, 400);
      }
      const candidate = raw as { id?: unknown };
      if (typeof candidate.id !== 'string' || !uuidSchema.safeParse(candidate.id).success) {
        return c.json({ error: 'Backup contains a note with an invalid id' }, 400);
      }
      if (noteIds.has(candidate.id)) {
        return c.json(
          { error: `Duplicate note id in backup: ${candidate.id}` },
          400,
        );
      }
      noteIds.add(candidate.id);
    }
    const attachmentIds = new Set<string>();
    for (const raw of rawAttachments) {
      if (!raw || typeof raw !== 'object') {
        return c.json({ error: 'Backup contains an invalid attachment record' }, 400);
      }
      const candidate = raw as { id?: unknown; noteId?: unknown; mime?: unknown };
      if (
        typeof candidate.id !== 'string' ||
        !uuidSchema.safeParse(candidate.id).success ||
        typeof candidate.noteId !== 'string' ||
        !uuidSchema.safeParse(candidate.noteId).success ||
        typeof candidate.mime !== 'string' ||
        !isAllowedUploadMime(candidate.mime)
      ) {
        return c.json({ error: 'Backup contains invalid attachment metadata' }, 400);
      }
      if (attachmentIds.has(candidate.id)) {
        return c.json(
          { error: `Duplicate attachment id in backup: ${candidate.id}` },
          400,
        );
      }
      attachmentIds.add(candidate.id);
    }
    // Reject invalid attachment metadata, missing note references, and
    // ownership conflicts before changing any notes. This keeps a malformed
    // backup from producing a partially imported database state.
    const referencedNoteIds = new Set(
      rawAttachments.map((raw) => (raw as { noteId: string }).noteId),
    );
    const existingNoteIds = referencedNoteIds.size > 0
      ? await db
        .select({ id: notes.id })
        .from(notes)
        .where(inArray(notes.id, Array.from(referencedNoteIds)))
      : [];
    const knownNoteIds = new Set([
      ...noteIds,
      ...existingNoteIds.map((row) => row.id),
    ]);
    for (const noteId of referencedNoteIds) {
      if (!knownNoteIds.has(noteId)) {
        return c.json({ error: `Attachment references a missing note: ${noteId}` }, 400);
      }
    }
    for (const raw of rawAttachments) {
      if (!raw || typeof raw !== 'object') {
        return c.json({ error: 'Backup contains an invalid attachment record' }, 400);
      }
      const candidate = raw as { id?: unknown; noteId?: unknown; mime?: unknown };
      if (typeof candidate.id !== 'string' || typeof candidate.noteId !== 'string') {
        return c.json({ error: 'Backup contains invalid attachment ownership' }, 400);
      }
      const existing = await db
        .select({ noteId: attachments.noteId })
        .from(attachments)
        .where(eq(attachments.id, candidate.id))
        .limit(1);
      if (existing.length > 0 && existing[0].noteId !== candidate.noteId) {
        return c.json(
          { error: `Attachment id is already assigned to another note: ${candidate.id}` },
          409,
        );
      }
    }
    // The byte and item limits protect the subsequent per-row encryption,
    // SQL, and presign loops from pathological backup payloads.

    // Insert notes. Server-encrypts content with master key and
    // bumps `version` so a subsequent PATCH will need If-Match: 1
    // (the client / sync layer will handle this on next pull).
    const userId = c.get('userId');
    let notesImported = 0;
    const now = new Date();

    for (const raw of rawNotes) {
      if (!raw || typeof raw !== 'object') continue;
      const n = raw as {
        id?: unknown;
        parentId?: unknown;
        title?: unknown;
        content?: unknown;
        isFolder?: unknown;
        isExpanded?: unknown;
        orderIdx?: unknown;
        tags?: unknown;
      };
      if (typeof n.id !== 'string') continue;

      let contentCt: Buffer | null = null;
      let contentNonce: Buffer | null = null;
      const plaintext =
        typeof n.content === 'string' ? n.content : '';
      if (plaintext.length > 0) {
        const enc = encrypt(plaintext);
        contentCt = enc.ct;
        contentNonce = enc.nonce;
      }

      // Upsert by id: if a note with this id already exists (because
      // we're re-importing the user's own backup onto their own
      // account), overwrite so the new content wins. Otherwise a
      // user could re-import forever and accumulate ghost rows.
      const id = n.id;
      const parentId =
        typeof n.parentId === 'string' ? n.parentId : null;
      const title = typeof n.title === 'string' ? n.title : 'Untitled';
      const isFolder =
        typeof n.isFolder === 'boolean' ? n.isFolder : false;
      const isExpanded =
        typeof n.isExpanded === 'boolean' ? n.isExpanded : true;
      const orderIdx =
        typeof n.orderIdx === 'number' ? n.orderIdx : now.getTime();
      const tags = Array.isArray(n.tags)
        ? (n.tags as string[]).filter((t) => typeof t === 'string')
        : [];

      // Recompute the FTS tsvector for BOTH insert and update branches.
      // Without it, a re-import of the user's own .treenote over
      // existing cloud rows would leave the GIN index pointing at the
      // PRE-import content (until the next regular PATCH which does
      // recompute). The `as unknown as string` cast narrows Drizzle's
      // column type (which declares `data: string`) so the SQL
      // expression is accepted — drizzle's runtime recognises `SQL`
      // instances and postgres-js serializes them as parameterized
      // expressions, so there's no injection risk in the cast.
      const tsvectorSql = sql`to_tsvector('simple', ${title} || ' ' || ${htmlToPlaintext(plaintext)})` as unknown as string;

      await db.transaction(async (tx) => {
        await tx
          .insert(notes)
          .values({
            id,
            parentId,
            title,
            contentCt,
            contentNonce,
            isFolder,
            isExpanded,
            orderIdx,
            tags,
            createdAt: now,
            updatedAt: now,
            version: 1,
            contentTsvector: tsvectorSql,
          })
          .onConflictDoUpdate({
            target: notes.id,
            set: {
              parentId,
              title,
              contentCt,
              contentNonce,
              isFolder,
              isExpanded,
              orderIdx,
              tags,
              isDeleted: false,
              deletedAt: null,
              updatedAt: now,
              version: sql`${notes.version} + 1`,
              contentTsvector: tsvectorSql,
            },
          });
        // A backup restore can recreate a previously purged stable ID.
        // Remove only its note tombstone in the same transaction.
        await tx
          .delete(tombstones)
          .where(and(
            eq(tombstones.resourceType, 'note'),
            eq(tombstones.resourceId, id),
          ));
      });
      notesImported += 1;
    }

    // Create attachment rows + presigned PUT URLs. We strip the
    // dataBase64 from the .treenote file once echoed back; the
    // client uploads each blob via URL.
    const uploads: BackupImportResponse['uploads'] = [];
    let attachmentsCreated = 0;

    for (const raw of rawAttachments) {
      if (!raw || typeof raw !== 'object') continue;
      const a = raw as {
        id?: unknown;
        noteId?: unknown;
        mime?: unknown;
        name?: unknown;
        createdAt?: unknown;
      };
      if (
        typeof a.id !== 'string' ||
        typeof a.noteId !== 'string' ||
        typeof a.mime !== 'string'
      ) {
        continue;
      }
      const attachmentId = a.id;
      const r2Key = generateR2Key(userId, a.mime);
      const createdAt =
        typeof a.createdAt === 'number' ? a.createdAt : now.getTime();

      const created = await db.transaction(async (tx) => {
        // Re-check ownership inside the transaction. The preflight check
        // above cannot protect against another request inserting the same
        // ID between validation and this write.
        const existing = await tx
          .select({ noteId: attachments.noteId })
          .from(attachments)
          .where(eq(attachments.id, attachmentId))
          .limit(1);
        if (existing.length > 0 && existing[0].noteId !== a.noteId) {
          return { conflict: true, created: false };
        }
        if (existing.length > 0) {
          // Preserve the canonical existing R2 object and avoid issuing an
          // orphan presigned key. The row is already owned by this note.
          await tx
            .delete(tombstones)
            .where(and(
              eq(tombstones.resourceType, 'attachment'),
              eq(tombstones.resourceId, attachmentId),
            ));
          return { conflict: false, created: false };
        }
        await tx
          .insert(attachments)
          .values({
            id: attachmentId,
            noteId: a.noteId,
            r2Key,
            mime: a.mime,
            name: typeof a.name === 'string' ? a.name : '',
            sizeBytes: 0, // unknown until client completes PUT
            createdAt: new Date(createdAt),
          } as typeof attachments.$inferInsert)
          .onConflictDoNothing();
        const stored = await tx
          .select({ noteId: attachments.noteId })
          .from(attachments)
          .where(eq(attachments.id, attachmentId))
          .limit(1);
        if (stored.length === 0 || stored[0].noteId !== a.noteId) {
          return { conflict: true, created: false };
        }
        await tx
          .delete(tombstones)
          .where(and(
            eq(tombstones.resourceType, 'attachment'),
            eq(tombstones.resourceId, attachmentId),
          ));
        return { conflict: false, created: true };
      });
      if (created.conflict) {
        return c.json(
          { error: `Attachment id is already assigned to another note: ${attachmentId}` },
          409,
        );
      }
      if (!created.created) continue;

      const uploadUrl = await presignPut(r2Key, a.mime);
      uploads.push({ attachmentId, uploadUrl, r2Key });
      attachmentsCreated += 1;
    }

    const response: BackupImportResponse = {
      notesImported,
      attachmentsCreated,
      uploads,
    };
    return c.json(response);
  },
);
