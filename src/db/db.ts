import Dexie, { type Table } from 'dexie';
import { v4 as uuidv4 } from 'uuid';
import {
  Attachment,
  ATTACHMENT_SRC_PREFIX,
  Note,
} from '../types';

export class TreeNoteDB extends Dexie {
  notes!: Table<Note, string>;
  attachments!: Table<Attachment, string>;

  constructor() {
    super('TreeNoteDB');

    // v1 schema (original) — declared so Dexie can upgrade existing
    // databases that were created with the old schema. Without this
    // declaration, Dexie cannot know what the previous schema looked
    // like and the upgrade path may not work correctly for existing users.
    this.version(1).stores({
      notes: 'id, parentId, title, content, order',
    });

    // v2 schema — drops the `content` and `title` indexes.
    // IndexedDB enforces a per-key size limit on indexed fields, and the
    // TipTap editor stores images as base64 data URLs inside `content`
    // (a single modest photo easily blows past 100KB once base64'd). With
    // `content` indexed under the v1 schema, `db.notes.update(…)`
    // threw a DataError the moment an image-bearing content payload was
    // written — `saveNote({ content })` failed silently, so the row in
    // IndexedDB never received the image. Every note switch, page reload,
    // or export -> import round-trip then surfaced a "missing" image.
    // Nothing in this codebase queries by `content` or `title` (search is
    // Fuse-based, tree ops are JS-side), so we can drop them from the
    // index without losing any functionality.
    this.version(2).stores({
      notes: 'id, parentId, order',
    });

    // v3 schema — introduces the attachments table.
    // notes: unchanged (still id, parentId, order) so that the v2 storage
    //   guarantee (content field is free of IndexedDB key-size limits) is
    //   preserved. That guarantee is pinned by db.test.ts; do NOT add an
    //   index on content.
    // attachments: id is the PK (we generate UUIDv4 ids in code); noteId
    //   is indexed so we can support a future per-note GC pass efficiently
    //   and so delete-by-noteId is O(attachments-for-that-note) rather than
    //   a full-table scan. The NodeView in ResizableImage.tsx resolves the
    //   src via db.attachments.get(id), which uses the PK.
    //
    // The upgrade callback runs once per database, atomically inside the
    // v3 upgrade transaction. It walks every note's `content`, decodes
    // every `<img src="data:image/...">` to a Blob, stores each Blob as a
    // new Attachment row, and rewrites the matching `src` attributes to
    // `${ATTACHMENT_SRC_PREFIX}<uuid>`. Existing v2 notes that contain no
    // inline data URLs (e.g. notes that were already migrated to use
    // external URLs) are left untouched by the id-pattern check below.
    //
    // This same migration logic runs again on the import path
    // (notes-io.ts) so that old `.treenote` backups opened on an
    // already-v3 database get the same promotion.
    this.version(3)
      .stores({
        notes: 'id, parentId, order',
        attachments: 'id, noteId',
      })
      .upgrade(async (tx) => {
        const notesTable = tx.table<Note, string>('notes');
        const attachmentsTable = tx.table<Attachment, string>('attachments');

        const notes = await notesTable.toArray();
        const newAttachments: Attachment[] = [];
        let mutatedNotes = 0;

        for (const note of notes) {
          if (!note.content || !note.content.includes('data:')) {
            continue;
          }
          const migrated = await migrateContentToAttachments(
            note.content,
            note.id,
            newAttachments,
          );
          if (migrated !== note.content) {
            await notesTable.update(note.id, { content: migrated });
            mutatedNotes += 1;
          }
        }

        if (newAttachments.length > 0) {
          await attachmentsTable.bulkAdd(newAttachments);
        }

        return {
          notesMutated: mutatedNotes,
          attachmentsCreated: newAttachments.length,
        };
      });

    // v4 schema — adds the multi-entry `*tags` index for the Tags
    // feature (Sidebar filter chip + Editor chip input). Notes that
    // pre-date v4 have no `tags` field; Dexie treats them as `[]`
    // (or `undefined`) so `tags` reads return empty arrays via the
    // helper in src/lib/tags.ts. No upgrade callback needed —
    // adding an index is a write-side restructure that Dexie
    // handles automatically.
    this.version(4).stores({
      notes: 'id, parentId, order, *tags',
      attachments: 'id, noteId',
    });
  }
}

export const db = new TreeNoteDB();

/**
 * Walk `content`, decode every `<img src="data:image/...?...">` and append
 * a corresponding `Attachment` to `out`. Returns the rewritten content
 * with those src attributes replaced by `attachment:<id>`.
 *
 * Exported separately from the v3 upgrade closure so the import flow in
 * notes-io.ts can call it directly when an older `.treenote` backup is
 * opened on an already-v3 database.
 *
 * Idempotent: content that does not contain `data:` anywhere is returned
 * unchanged and `out` is not touched. (Cheap pre-check; the regex below
 * is only run on content that might actually contain inline base64.)
 *
 * Behaviour for malformed data URLs:
 *   - regex matches but `atob` throws -> leave the original `<img>` in
 *     place. The image will still display via the data URL pass-through
 *     in ResizableImage.tsx, so we never lose user data to a faulty
 *     migration.
 */
export async function migrateContentToAttachments(
  content: string,
  noteId: string,
  out: Attachment[],
): Promise<string> {
  if (!content || !content.includes('data:')) return content;

  return content.replace(
    /<img\s+([^>]*?)src="(data:[^"]*)"([^>]*)>/gi,
    (match, before: string, src: string, after: string) => {
      const decoded = decodeDataUrlToBlob(src);
      if (!decoded) return match; // undecodable — leave inline
      const id = uuidv4();
      out.push({
        id,
        noteId,
        blob: decoded.blob,
        mime: decoded.mime,
        name: '',
        createdAt: Date.now(),
      });
      return `<img ${before}src="${ATTACHMENT_SRC_PREFIX}${id}"${after}>`;
    },
  );
}

/**
 * Decode a `data:<mime>(;base64)?,DataSegment` URL into a Blob. Returns
 * null when the URL is structurally invalid or when `atob` fails (so the
 * migration helper can leave the original markup intact).
 */
function decodeDataUrlToBlob(
  dataUrl: string,
): { mime: string; blob: Blob } | null {
  // Match `data:<mime>;base64,<b64>` and the rarer URL-encoded form.
  const match = /^data:([^;,]+)(?:;(base64))?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = match[1];
  const isBase64 = match[2] === 'base64';
  const body = match[3];
  try {
    let bytes: Uint8Array;
    if (isBase64) {
      const decoded = atob(body);
      bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        bytes[i] = decoded.charCodeAt(i);
      }
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
    return { mime, blob: new Blob([bytes], { type: mime }) };
  } catch {
    return null;
  }
}

/**
 * Garbage-collect orphan attachments — attachments whose id no longer
 * appears inside any note's `content` as `attachment:<id>`. Runs as a
 * fire-and-forget pass at app start (see main.tsx).
 *
 * Cost: O(notes + attachments) per call. Uses String#matchAll so the
 * regex doesn't carry global-flag state across iterations (cleaner than
 * a manual re.exec() loop with lastIndex resets). Safe to run repeatedly.
 */
export async function gcAttachments(): Promise<number> {
  const allAtts = await db.attachments.toArray();
  if (allAtts.length === 0) return 0;

  const notes = await db.notes.toArray();
  const referenced = new Set<string>();
  const ATTACHMENT_RE = new RegExp(
    `<img\\s+[^>]*src="${ATTACHMENT_SRC_PREFIX}([^"]+)"`,
    'gi',
  );
  for (const note of notes) {
    if (!note.content) continue;
    for (const m of note.content.matchAll(ATTACHMENT_RE)) {
      referenced.add(m[1]);
    }
  }

  const orphans = allAtts
    .filter((a) => !referenced.has(a.id))
    .map((a) => a.id);
  if (orphans.length === 0) return 0;

  await db.attachments.bulkDelete(orphans);
  return orphans.length;
}
