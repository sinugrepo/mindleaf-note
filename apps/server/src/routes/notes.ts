import { Hono } from 'hono';
import { db, pgClient } from '../db/index.js';
import { notes, attachments, tombstones } from '../db/schema.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { encrypt, decrypt } from '../crypto.js';
import { randomUUID } from 'node:crypto';
import { htmlToPlaintext } from '../html-to-text.js';
import type { NoteDTO } from '@mindleaf/shared';
import type { AppEnv } from '../env.js';

// ----------------------------------------------------------------------------
// Phase 6 — tsvector recompilation note
// ----------------------------------------------------------------------------
// The `contentTsvector` column is declared in `db/schema.ts` as a customType
// with `data: string`. Drizzle's TypeScript inference sees only that string,
// so a raw `sql\`to_tsvector(...)\`` expression fails assignability checks
// (TS2322). The runtime recognises `SQL` instances as passthrough
// expressions and postgres-js serializes them as parameterized SQL, so the
// `as unknown as string` cast lets us write the column with correct on-write
// recompute behaviour while keeping a typed column for reads. No injection
// risk: parameters are still bound positionally via the sql template.
// ----------------------------------------------------------------------------

export const notesRoutes = new Hono<AppEnv>();

/**
 * Convert a Drizzle `notes` row to a decrypted NoteDTO.
 * Content is decrypted from `content_ct` + `content_nonce`.
 */
function rowToDTO(
  row: typeof notes.$inferSelect,
  decryptedContent: string,
): NoteDTO {
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    content: decryptedContent,
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

/**
 * Decrypt a note row's content. Returns empty string for notes with
 * no ciphertext (e.g. freshly created notes before first save).
 */
function decryptRow(row: typeof notes.$inferSelect): string {
  if (!row.contentCt || !row.contentNonce) return '';
  return decrypt(row.contentCt, row.contentNonce);
}

/**
 * Collect a note + all its descendant IDs via a recursive CTE.
 * Uses postgres-js's parameterized template tag (safe from injection).
 */
async function collectDescendantIds(noteId: string): Promise<string[]> {
  const rows = (await pgClient`
    WITH RECURSIVE descendants AS (
      SELECT id FROM notes WHERE id = ${noteId}::uuid
      UNION ALL
      SELECT n.id FROM notes n
      INNER JOIN descendants d ON n.parent_id = d.id
    )
    SELECT id FROM descendants
  `) as { id: string }[];
  return rows.map((r) => r.id);
}

// --- GET / (tree: all active notes, decrypted) ---
notesRoutes.get('/', async (c) => {
  const rows = await db
    .select()
    .from(notes)
    .where(eq(notes.isDeleted, false));

  const dtos = rows.map((r) => rowToDTO(r, decryptRow(r)));
  return c.json(dtos);
});

// --- GET /trash ---
notesRoutes.get('/trash', async (c) => {
  const rows = await db
    .select()
    .from(notes)
    .where(eq(notes.isDeleted, true));

  const dtos = rows.map((r) => rowToDTO(r, decryptRow(r)));
  return c.json(dtos);
});

// --- GET /:id (single note, decrypted) ---
notesRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  if (rows.length === 0) {
    return c.json({ error: 'Note not found' }, 404);
  }
  return c.json(rowToDTO(rows[0], decryptRow(rows[0])));
});

// --- POST / (create note) ---
notesRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = body.id ?? randomUUID();
  const parentId = body.parentId ?? null;
  const title = body.title ?? '';
  const isFolder = body.isFolder ?? false;
  const now = new Date();

  // Encrypt content if provided.
  let contentCt: Buffer | null = null;
  let contentNonce: Buffer | null = null;
  if (typeof body.content === 'string' && body.content.length > 0) {
    const enc = encrypt(body.content);
    contentCt = enc.ct;
    contentNonce = enc.nonce;
  }

  // Recompute the FTS tsvector (cast rationale: see header comment
  // block at the top of this file). Computed once and reused for both
  // the insert and the onConflictDoUpdate branches.
  const tsvectorSql = sql`to_tsvector('simple', ${title} || ' ' || ${htmlToPlaintext(body.content ?? '')})` as unknown as string;

  // Keep recreate/upsert and tombstone removal in one transaction. Without
  // this, a note recreated with the same stable ID could be deleted again by
  // the next delta pull because its old tombstone would still be present.
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(notes)
      .values({
        id,
        parentId,
        title,
        contentCt,
        contentNonce,
        isFolder,
        isExpanded: true,
        orderIdx: body.orderIdx ?? now.getTime(),
        tags: body.tags ?? [],
        createdAt: now,
        updatedAt: now,
        version: 1,
        // Phase 6: tsvector for full text search. Server computes
        // `to_tsvector('simple', title || ' ' || plaintext(content))`
        // so the FTS GIN index is up to date immediately.
        contentTsvector: tsvectorSql,
      })
      // Idempotent upsert (Phase 8 — onboarding re-entrancy).
      .onConflictDoUpdate({
        target: notes.id,
        set: {
          parentId,
          title,
          contentCt,
          contentNonce,
          isFolder,
          orderIdx: body.orderIdx ?? now.getTime(),
          tags: body.tags ?? [],
          isDeleted: false,
          deletedAt: null,
          updatedAt: now,
          version: sql`${notes.version} + 1`,
          contentTsvector: tsvectorSql,
        },
      })
      .returning();

    await tx
      .delete(tombstones)
      .where(and(
        eq(tombstones.resourceType, 'note'),
        eq(tombstones.resourceId, id),
      ));
    return created;
  });

  return c.json(rowToDTO(row, body.content ?? ''), 201);
});

// --- PATCH /:id (update note with optimistic locking via If-Match) ---
notesRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  // Check If-Match header for optimistic locking.
  const ifMatch = c.req.header('If-Match');
  const expectedVersion = ifMatch ? parseInt(ifMatch, 10) : null;

  // Fetch current row.
  const rows = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  if (rows.length === 0) {
    return c.json({ error: 'Note not found' }, 404);
  }
  const current = rows[0];

  // Version conflict check.
  if (expectedVersion !== null && current.version !== expectedVersion) {
    return c.json(
      {
        error: 'Conflict — note was updated elsewhere',
        remote: rowToDTO(current, decryptRow(current)),
      },
      409,
    );
  }

  // Build the update patch.
  const patch: Partial<typeof notes.$inferInsert> = {
    updatedAt: new Date(),
    version: current.version + 1,
  };

  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.content === 'string') {
    const enc = encrypt(body.content);
    patch.contentCt = enc.ct;
    patch.contentNonce = enc.nonce;
  }
  if (typeof body.isExpanded === 'boolean') patch.isExpanded = body.isExpanded;
  if (typeof body.orderIdx === 'number') patch.orderIdx = body.orderIdx;
  if (body.parentId !== undefined) patch.parentId = body.parentId;
  if (Array.isArray(body.tags)) patch.tags = body.tags;

  // Phase 6: if title or content changed, recompute the FTS index. We
  // use the INCOMING body values when present (so the index matches the
  // post-update state, not the pre-update state), and fall back to the
  // current row values otherwise.
  const titleChanged = typeof body.title === 'string';
  const contentChanged = typeof body.content === 'string';
  const effectiveTitle = titleChanged ? body.title : current.title;
  const effectivePlaintext = contentChanged
    ? htmlToPlaintext(body.content)
    : htmlToPlaintext(decryptRow(current));
  if (titleChanged || contentChanged) {
    // Same cast rationale as the POST branch above — see comments.
    patch.contentTsvector = sql`to_tsvector('simple', ${effectiveTitle} || ' ' || ${effectivePlaintext})` as unknown as string;
  }


  const [updated] = await db
    .update(notes)
    .set(patch)
    .where(eq(notes.id, id))
    .returning();

  // Return the updated DTO with the decrypted content (so the client
  // can verify what the server now holds).
  const decryptedContent =
    typeof body.content === 'string' ? body.content : decryptRow(updated);
  return c.json(rowToDTO(updated, decryptedContent));
});

// --- DELETE /:id (soft-delete note + descendants) ---
// Uses a recursive CTE to collect all descendants, then stamps
// `is_deleted = true` + `deleted_at = now()` on each.
notesRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const now = new Date();

  const ids = await collectDescendantIds(id);
  if (ids.length === 0) {
    // DELETE is intentionally idempotent: an offline mutation may arrive
    // after another device already purged this note. Returning success keeps
    // the client queue from producing a permanent, noisy 404 retry.
    return c.json({ ok: true, deleted: 0 });
  }

  // Soft-delete all collected ids using Drizzle's inArray (parameterized).
  await db
    .update(notes)
    .set({
      isDeleted: true,
      deletedAt: now,
      updatedAt: now,
      version: sql`${notes.version} + 1`,
    })
    .where(inArray(notes.id, ids));

  return c.json({ ok: true, deleted: ids.length });
});

// --- POST /:id/restore (restore note + descendants from trash) ---
notesRoutes.post('/:id/restore', async (c) => {
  const id = c.req.param('id');
  const now = new Date();

  const ids = await collectDescendantIds(id);
  if (ids.length === 0) {
    // Restore is also idempotent for stale offline mutations. The desired
    // state cannot be applied to a row that was already purged, but there is
    // nothing left for the client to retry.
    return c.json({ ok: true, restored: 0 });
  }

  await db
    .update(notes)
    .set({
      isDeleted: false,
      deletedAt: null,
      updatedAt: now,
      version: sql`${notes.version} + 1`,
    })
    .where(inArray(notes.id, ids));

  return c.json({ ok: true, restored: ids.length });
});

// --- POST /:id/permanent (permanently delete from trash) ---
notesRoutes.post('/:id/permanent', async (c) => {
  const id = c.req.param('id');

  // Only allow permanent delete on already-trashed notes.
  const rows = await db
    .select()
    .from(notes)
    .where(eq(notes.id, id))
    .limit(1);

  if (rows.length === 0) {
    // Hard-delete is idempotent too: a retention job or another device may
    // already have removed the note before this queued mutation arrived.
    return c.json({ ok: true, deleted: 0 });
  }
  if (!rows[0].isDeleted) {
    return c.json({ error: 'Note is not in trash' }, 400);
  }

  const ids = await collectDescendantIds(id);
  const attachmentRows = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(inArray(attachments.noteId, ids));

  // Preserve deletion facts and remove the source rows atomically. The
  // unique resource index makes retries idempotent; a failed transaction
  // cannot leave clients with tombstones for data that still exists.
  const deletionRows = [
    ...ids.map((resourceId) => ({ resourceType: 'note', resourceId })),
    ...attachmentRows.map(({ id: resourceId }) => ({ resourceType: 'attachment', resourceId })),
  ];
  await db.transaction(async (tx) => {
    if (deletionRows.length > 0) {
      await tx.insert(tombstones).values(deletionRows).onConflictDoUpdate({
        target: [tombstones.resourceType, tombstones.resourceId],
        set: { deletedAt: new Date() },
      });
    }
    await tx.delete(notes).where(inArray(notes.id, ids));
  });

  return c.json({ ok: true, deleted: ids.length });
});
