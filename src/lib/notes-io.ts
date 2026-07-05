import { Attachment, Note, ATTACHMENT_SRC_PREFIX } from '../types';
import { db, migrateContentToAttachments } from '../db/db';

/**
 * File-name prefix for exported backups. The extension `.treenote` is used
 * alongside `.json` (both accepted on import) — see Sidebar's file input
 * `accept=".json,.treenote"`.
 */
export const BACKUP_FILE_PREFIX = 'treenote-backup';

/**
 * Inline version that v2 backups stamp on the top-level payload object so
 * we can tell v1 (array-of-notes) from v2 (object with notes+attachments).
 */
const BACKUP_VERSION_V2 = 2;

interface RawAttachmentV2 {
  id?: unknown;
  noteId?: unknown;
  mime?: unknown;
  name?: unknown;
  createdAt?: unknown;
  dataBase64?: unknown;
}

/**
 * Synchronous, light-weight attachment row extracted from a v2 backup blob.
 * The base64 segment is hydrated to a Blob by `importBackupFromFile` (kept
 * separate from parsing so `parseImportedBackup` stays sync and testable).
 */
export interface ParsedBackupAttachment {
  id: string;
  noteId: string;
  mime: string;
  name: string;
  createdAt: number;
  dataBase64: string;
}

/**
 * Hydrated attachments produced by `importBackupFromFile`. Each row is
 * ready for `db.attachments.bulkPut(...)` — `blob` already decoded.
 */
export interface ResolvedAttachment {
  id: string;
  noteId: string;
  blob: Blob;
  mime: string;
  name: string;
  createdAt: number;
}

export interface ParsedBackup {
  notes: Note[];
  attachments: ParsedBackupAttachment[];
}

export interface BackupImportResult {
  notes: Note[];
  attachments: ResolvedAttachment[];
}

/**
 * Trigger a browser download of the user's notes AND every attachment that
 * belongs to those notes (base64 inlined so the file remains a single
 * static artifact users can sync however they want).
 *
 * Caller is responsible for try/catch and user-facing error messaging.
 */
export async function exportNotesAsFile(notes: Note[]): Promise<void> {
  const noteIds = notes.map((n) => n.id);
  // Bulk-export is small per user typically; the indexed noteId lookup
  // keeps this O(notesInSubset + attachmentsInSubset) rather than a full
  // table scan when we already know the subset.
  const attachments =
    noteIds.length === 0
      ? []
      : await db.attachments.where('noteId').anyOf(noteIds).toArray();

  const serialized = await Promise.all(
    attachments.map(async (a) => ({
      id: a.id,
      noteId: a.noteId,
      mime: a.mime,
      name: a.name,
      createdAt: a.createdAt,
      dataBase64: await blobToBase64(a.blob),
    })),
  );

  const payload = {
    version: BACKUP_VERSION_V2,
    notes,
    attachments: serialized,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const today = new Date().toISOString().slice(0, 10);
  a.download = `${BACKUP_FILE_PREFIX}-${today}.treenote`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Chunked base64 encoder. Calling `String.fromCharCode(...hugeArray)` in
 * one go trips a stack overflow / RangeError on large blobs; routing
 * through 8 KiB slices is the standard escape valve.
 */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

function base64ToBlob(dataBase64: string, mime: string): Blob {
  const decoded = atob(dataBase64);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Synchronous JSON -> ParsedBackup.
 *  - Top-level array  -> legacy v1: notes only, attachments=[].
 *  - Object with `version: 2, notes: [...], attachments: [...]`  -> v2.
 *  - Anything else   -> null. Sidebar uses this to surface a "Invalid
 *    backup file" alert.
 */
export function parseImportedBackup(json: unknown): ParsedBackup | null {
  if (Array.isArray(json)) {
    // Legacy v1 backup: array of notes, no attachments namespace. Notes
    // may still contain inline data URLs — those get rewritten to
    // attachment refs in `importBackupFromFile` post-parse.
    return { notes: parseImportedNotes(json), attachments: [] };
  }
  if (json && typeof json === 'object') {
    const obj = json as {
      version?: unknown;
      notes?: unknown;
      attachments?: unknown;
    };
    if (obj.version === BACKUP_VERSION_V2 && Array.isArray(obj.notes)) {
      return {
        notes: parseImportedNotes(obj.notes),
        attachments: parseImportedAttachmentsList(obj.attachments),
      };
    }
  }
  return null;
}

function parseImportedAttachmentsList(raw: unknown): ParsedBackupAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is RawAttachmentV2 => !!entry && typeof entry === 'object',
    )
    .filter(
      (entry) =>
        typeof entry.id === 'string' &&
        typeof entry.noteId === 'string' &&
        typeof entry.mime === 'string' &&
        typeof entry.dataBase64 === 'string',
    )
    .map(
      (entry): ParsedBackupAttachment => ({
        id: entry.id as string,
        noteId: entry.noteId as string,
        mime: entry.mime as string,
        name: typeof entry.name === 'string' ? entry.name : '',
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
        dataBase64: entry.dataBase64 as string,
      }),
    );
}

/**
 * Read a backup `File` and produce a fully hydrated BackupImportResult.
 *  - Hydrates `dataBase64` -> Blob.
 *  - Runs the v3 migration helper on any leftover inline data URLs in
 *    note content (the v3 upgrade already ran at db open; this is the
 *    our belt-and-suspenders pass for backups that predate v3 OR were
 *    last saved when v3 hadn't run yet).
 *
 * Returns null on read/parse failure so Sidebar can surface a single
 * consolidated error message.
 */
export async function importBackupFromFile(
  file: File,
): Promise<BackupImportResult | null> {
  const text = await file.text().catch(() => null);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = parseImportedBackup(json);
  if (parsed === null) return null;

  // 1) Hydrate base64 -> Blob for the attachments explicitly listed in v2.
  const hydratedFromBackup: ResolvedAttachment[] = await Promise.all(
    parsed.attachments.map(async (a) => ({
      id: a.id,
      noteId: a.noteId,
      blob: base64ToBlob(a.dataBase64, a.mime),
      mime: a.mime,
      name: a.name,
      createdAt: a.createdAt,
    })),
  );

  // 2) Run the same in-place migration the v3 upgrade runs, so notes that
  // still hold legacy inline base64 get promoted to attachment rows + the
  // content src rewritten to `attachment:<id>`. We push any new
  // attachments onto the result so the caller bulkPuts them all in one
  // go.
  const newAttachments: Attachment[] = [];
  const migratedNotes: Note[] = [];
  for (const note of parsed.notes) {
    if (!note.content || !note.content.includes('data:')) {
      migratedNotes.push(note);
      continue;
    }
    const rewritten = await migrateContentToAttachments(
      note.content,
      note.id,
      newAttachments,
    );
    migratedNotes.push({ ...note, content: rewritten });
  }

  const migratedResolved: ResolvedAttachment[] = newAttachments.map((a) => ({
    id: a.id,
    noteId: a.noteId,
    blob: a.blob,
    mime: a.mime,
    name: a.name,
    createdAt: a.createdAt,
  }));

  return {
    notes: migratedNotes,
    attachments: [...hydratedFromBackup, ...migratedResolved],
  };
}

// ---------------------------------------------------------------------------
// Legacy parseImportedNotes — kept unchanged for backwards compatibility and
// for any callers/tests that don't care about attachments. Same field-type
// defensive coercion as before; never silently drops user data.
// ---------------------------------------------------------------------------

/**
 * Structural shape accepted from `JSON.parse` on a backup blob.
 * Every field is `unknown` because we never trust untyped external data.
 */
interface RawImportedNote {
  id?: unknown;
  parentId?: unknown;
  title?: unknown;
  content?: unknown;
  order?: unknown;
  isExpanded?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  isFolder?: unknown;
}

/**
 * Normalize imported notes so missing fields get safe defaults & no
 * `undefined` leaks into the DB (which would break tree rendering & editor
 * loading). Filters out entries that lack the minimum required fields:
 *   - `id` must be a string (becomes Dexie primary key)
 *   - `content` must be a string (so the TipTap editor can load it and
 *     image data-URLs survive the round-trip)
 *
 * Contract note: `deletedAt` is INTENTIONALLY NOT carried over from the
 * backup. Importing a .treenote that contained trashed items treats
 * them as active — i.e. "import = restore everything". This matches the
 * recovery intent of opening a backup file. If you change this in the
 * future, also rework the Sidebar handler so the user gets an explicit
 * "Restore everything (incl. trash)" prompt before bulkPut.
 *
 * Returns the safe notes that can be handed to `db.notes.bulkPut(...)`.
 * Empty array means: either the JSON was not an array, or no entries
 * passed the minimum-field filter.
 */
export function parseImportedNotes(json: unknown): Note[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json
    .filter(
      (entry): entry is RawImportedNote =>
        !!entry && typeof entry === 'object',
    )
    .filter(
      (entry) =>
        typeof entry.id === 'string' && typeof entry.content === 'string',
    )
    .map(
      (entry): Note => ({
        id: entry.id as string,
        parentId:
          typeof entry.parentId === 'string' ? entry.parentId : null,
        title: typeof entry.title === 'string' ? entry.title : 'Untitled',
        content: entry.content as string,
        order: typeof entry.order === 'number' ? entry.order : 0,
        isExpanded:
          typeof entry.isExpanded === 'boolean' ? entry.isExpanded : false,
        createdAt:
          typeof entry.createdAt === 'number' ? entry.createdAt : 0,
        updatedAt:
          typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
        isFolder:
          typeof entry.isFolder === 'boolean' ? entry.isFolder : undefined,
      }),
    );
}

// Kept for Sidebar fallback paths; the new flow goes through
// `importBackupFromFile`. Exported for any future regression test that
// needs the raw notes-only ingestion shape.
export async function importNotesFromFile(
  file: File,
): Promise<Note[] | null> {
  const text = await file.text().catch(() => null);
  if (text === null) return null;
  try {
    return parseImportedNotes(JSON.parse(text));
  } catch {
    return null;
  }
}

// (No additional re-exports. ATTACHMENT_SRC_PREFIX lives in `../types`
// and every consumer imports it directly from there.)
