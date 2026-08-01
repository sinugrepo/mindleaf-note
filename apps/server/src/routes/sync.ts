import { Hono } from 'hono';
import { and, asc, eq, gt, lte, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { notes, attachments, tombstones } from '../db/schema.js';
import { decrypt } from '../crypto.js';
import type {
  SyncCursor,
  SyncSnapshot,
  SyncStreamCursor,
  TombstoneDTO,
  NoteDTO,
  AttachmentDTO,
} from '@mindleaf/shared';
import type { AppEnv } from '../env.js';

export const syncRoutes = new Hono<AppEnv>();

const DEFAULT_PAGE_SIZE = 250;
const MAX_PAGE_SIZE = 500;
const DEFAULT_TOMBSTONE_RETENTION_DAYS = 90;

function getTombstoneRetentionDays(): number {
  const configured = Number.parseInt(process.env.TOMBSTONE_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TOMBSTONE_RETENTION_DAYS;
}

function parseLimit(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function decodeCursor(raw: string | undefined): SyncCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<SyncCursor>;
    const boundary = parsed.boundary;
    const streams = [parsed.notes, parsed.attachments, parsed.tombstones];
    if (
      typeof boundary !== 'number' ||
      !Number.isFinite(boundary) ||
      boundary < 0 ||
      streams.some((stream) =>
        !stream ||
        typeof stream.id !== 'string' ||
        typeof stream.updatedAt !== 'number' ||
        !Number.isFinite(stream.updatedAt) ||
        stream.updatedAt < 0 ||
        stream.updatedAt > boundary
      )
    ) return null;
    return parsed as SyncCursor;
  } catch {
    return null;
  }
}

function initialStreamCursor(sinceMs: number): SyncStreamCursor {
  return { updatedAt: Math.max(0, sinceMs), id: '' };
}

function cursorFromDate(id: string, date: Date): SyncStreamCursor {
  return { id, updatedAt: date.getTime() };
}

/**
 * GET /api/sync/snapshot?since=<epoch_ms>&cursor=<opaque>&limit=<n>
 *
 * The first request captures a fixed server boundary. Every subsequent page
 * reuses that boundary and advances each stream by `(timestamp, id)`, so a
 * write racing the query is picked up by the next sync rather than skipped.
 */
syncRoutes.get('/snapshot', async (c) => {
  const limit = parseLimit(c.req.query('limit'));
  const rawSince = c.req.query('since');
  const sinceMs = rawSince ? Number.parseInt(rawSince, 10) : 0;
  if (!Number.isFinite(sinceMs) || sinceMs < 0) {
    return c.json({ error: 'Invalid since parameter' }, 400);
  }

  const decoded = decodeCursor(c.req.query('cursor'));
  if (c.req.query('cursor') && !decoded) {
    return c.json({ error: 'Invalid sync cursor' }, 400);
  }

  const retentionDays = getTombstoneRetentionDays();
  const retentionCutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const cursorTimeMs = decoded?.boundary ?? sinceMs;
  // A cursor older than the tombstone journal cannot safely reconcile hard
  // deletes: those tombstones may already have been purged. Stop with an
  // explicit recovery response instead of silently advancing the cursor and
  // leaving stale local notes behind. A zero cursor is a new-device/full
  // bootstrap and is intentionally allowed.
  if (cursorTimeMs > 0 && cursorTimeMs < retentionCutoffMs) {
    return c.json({
      error: 'sync_cursor_expired',
      recoveryRequired: true,
      retentionDays,
    }, 410);
  }

  const cursor: SyncCursor = decoded ?? {
    boundary: Date.now(),
    notes: initialStreamCursor(sinceMs),
    attachments: initialStreamCursor(sinceMs),
    tombstones: initialStreamCursor(sinceMs),
  };
  const boundary = new Date(cursor.boundary);

  const noteRows = await db
    .select()
    .from(notes)
    .where(and(
      lte(notes.updatedAt, boundary),
      or(
        gt(notes.updatedAt, new Date(cursor.notes?.updatedAt ?? 0)),
        and(
          eq(notes.updatedAt, new Date(cursor.notes?.updatedAt ?? 0)),
          gt(notes.id, cursor.notes?.id ?? ''),
        ),
      ),
    ))
    .orderBy(asc(notes.updatedAt), asc(notes.id))
    .limit(limit + 1);

  const attachmentRows = await db
    .select()
    .from(attachments)
    .where(and(
      lte(attachments.createdAt, boundary),
      or(
        gt(attachments.createdAt, new Date(cursor.attachments?.updatedAt ?? 0)),
        and(
          eq(attachments.createdAt, new Date(cursor.attachments?.updatedAt ?? 0)),
          gt(attachments.id, cursor.attachments?.id ?? ''),
        ),
      ),
    ))
    .orderBy(asc(attachments.createdAt), asc(attachments.id))
    .limit(limit + 1);

  const tombstoneRows = await db
    .select()
    .from(tombstones)
    .where(and(
      lte(tombstones.deletedAt, boundary),
      or(
        gt(tombstones.deletedAt, new Date(cursor.tombstones?.updatedAt ?? 0)),
        and(
          eq(tombstones.deletedAt, new Date(cursor.tombstones?.updatedAt ?? 0)),
          gt(tombstones.id, cursor.tombstones?.id ?? ''),
        ),
      ),
    ))
    .orderBy(asc(tombstones.deletedAt), asc(tombstones.id))
    .limit(limit + 1);

  const pageNotes = noteRows.slice(0, limit);
  const pageAttachments = attachmentRows.slice(0, limit);
  const pageTombstones = tombstoneRows.slice(0, limit);

  const noteDtos: NoteDTO[] = pageNotes.map((r) => {
    let content = '';
    try {
      content = r.contentCt && r.contentNonce ? decrypt(r.contentCt, r.contentNonce) : '';
    } catch {
      console.error(`[sync] Failed to decrypt note ${r.id}`);
    }
    return {
      id: r.id,
      parentId: r.parentId,
      title: r.title,
      content,
      isFolder: r.isFolder,
      isExpanded: r.isExpanded,
      orderIdx: r.orderIdx,
      tags: r.tags ?? [],
      deletedAt: r.deletedAt ? r.deletedAt.getTime() : null,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
      version: r.version,
    };
  });

  const attachmentDtos: AttachmentDTO[] = pageAttachments.map((a) => ({
    id: a.id,
    noteId: a.noteId,
    r2Key: a.r2Key,
    mime: a.mime,
    name: a.name,
    sizeBytes: a.sizeBytes,
    createdAt: a.createdAt.getTime(),
  }));

  const tombstoneDtos: TombstoneDTO[] = pageTombstones.map((row) => ({
    resourceType: row.resourceType === 'attachment' ? 'attachment' : 'note',
    resourceId: row.resourceId,
    deletedAt: row.deletedAt.getTime(),
  }));

  const nextCursor: SyncCursor = {
    boundary: cursor.boundary,
    notes: pageNotes.length > 0
      ? cursorFromDate(pageNotes[pageNotes.length - 1].id, pageNotes[pageNotes.length - 1].updatedAt)
      : cursor.notes,
    attachments: pageAttachments.length > 0
      ? cursorFromDate(pageAttachments[pageAttachments.length - 1].id, pageAttachments[pageAttachments.length - 1].createdAt)
      : cursor.attachments,
    tombstones: pageTombstones.length > 0
      ? cursorFromDate(pageTombstones[pageTombstones.length - 1].id, pageTombstones[pageTombstones.length - 1].deletedAt)
      : cursor.tombstones,
  };
  const hasMore = noteRows.length > limit || attachmentRows.length > limit || tombstoneRows.length > limit;

  const snapshot: SyncSnapshot = {
    serverNow: cursor.boundary,
    notes: noteDtos,
    attachments: attachmentDtos,
    tombstones: tombstoneDtos,
    hasMore,
    nextCursor: hasMore ? nextCursor : null,
  };
  return c.json(snapshot);
});
