import { Hono } from 'hono';
import { db } from '../db/index.js';
import { notes, attachments } from '../db/schema.js';
import { gte } from 'drizzle-orm';
import { decrypt } from '../crypto.js';
import type { SyncSnapshot, NoteDTO, AttachmentDTO } from '@mindleaf/shared';
import type { AppEnv } from '../env.js';

export const syncRoutes = new Hono<AppEnv>();

/**
 * GET /api/sync/snapshot?since=<epoch_ms>
 *
 * Returns all notes and attachments whose `updatedAt` (or `createdAt`
 * for attachments) is newer than `since`. The client applies the
 * delta: notes with a higher `version` overwrite the local cache;
 * notes with a lower or equal version are skipped (local edits win).
 *
 * V1 does NOT paginate — for a single-user personal note app with
 * thousands of notes, the full payload is ~1-5 MB and acceptable at
 * a 60-second polling cadence.
 */
syncRoutes.get('/snapshot', async (c) => {
  const sinceParam = c.req.query('since');
  const sinceMs = sinceParam ? parseInt(sinceParam, 10) : 0;
  if (isNaN(sinceMs)) {
    return c.json({ error: 'Invalid since parameter' }, 400);
  }
  const sinceDate = new Date(sinceMs);

  // Fetch notes updated after `since`.
  const noteRows = await db
    .select()
    .from(notes)
    .where(gte(notes.updatedAt, sinceDate));

  const noteDtos: NoteDTO[] = noteRows.map((r) => {
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

  // Fetch attachments created after `since`.
  const attRows = await db
    .select()
    .from(attachments)
    .where(gte(attachments.createdAt, sinceDate));

  const attDtos: AttachmentDTO[] = attRows.map((a) => ({
    id: a.id,
    noteId: a.noteId,
    r2Key: a.r2Key,
    mime: a.mime,
    name: a.name,
    sizeBytes: a.sizeBytes,
    createdAt: a.createdAt.getTime(),
  }));

  const snapshot: SyncSnapshot = {
    serverNow: Date.now(),
    notes: noteDtos,
    attachments: attDtos,
  };

  return c.json(snapshot);
});
