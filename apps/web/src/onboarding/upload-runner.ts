/**
 * Phase 8 — Bulk upload routines for the Onboarding Wizard.
 *
 * Two runners:
 *   - `bulkUploadNotes(onProgress)` — chunked parallel POST /notes
 *     with per-chunk `dirty=false` + `lastSyncedAt=now` stamping so a
 *     re-opened wizard can resume from where it left off.
 *   - `bulkUploadAttachments(onProgress)` — chunked parallel
 *     presignUpload → fetch PUT → completeUpload per attachment.
 *
 * Re-entrancy
 * -----------
 * Each iteration picks `notes` whose `lastSyncedAt` is `null/undefined`
 * OR `attachments` whose `syncStatus !== 'synced' + r2Key !== null`.
 * Successful uploads stamp the corresponding timestamp / status, so
 * a re-mount after a browser crash resumes only on unprocessed rows.
 *
 * The backend POST /notes is idempotent (Phase 8 added `onConflictDoUpdate`
 * on conflict) — so even if a chunk response is lost in flight and the
 * server processed it, a retry resolves cleanly without 500-ing.
 *
 * Concurrency
 * -----------
 * Notes chunk 10, attachments chunk 5 (each attachment does 3
 * round-trips: presign, PUT, complete — bigger payload per request,
 * tighter cap).
 */

import { v4 as uuidv4 } from 'uuid';
import type { Note, Attachment } from '../types';
import { db } from '../db/db';
import { api } from '../api/client';

/** Active-note filter (excludes trash, mirrors Sidebar / TrashView). */
function isActiveLocal(n: Note): boolean {
  return n.deletedAt == null;
}

export interface NoteProgress {
  notesUploaded: number;
  totalNotes: number;
}

export interface AttachmentProgress {
  imagesUploaded: number;
  totalImages: number;
}

const NOTES_CHUNK = 10;
const ATTACHMENTS_CHUNK = 5;

/**
 * Bulk-upload all active local notes whose `lastSyncedAt` is unset.
 * Stamps `lastSyncedAt` (and clears `dirty`) on success.
 *
 * Returns counts. Failures count toward `notOk` for the toast summary
 * but are NOT marked synced — they will be retried on the next resume.
 */
export async function bulkUploadNotes(
  onProgress: (p: NoteProgress) => void,
  signal?: AbortSignal,
): Promise<{ ok: number; notOk: number }> {
  const candidates: Note[] = (await db.notes.toArray())
    .filter(isActiveLocal)
    .filter((n) => n.lastSyncedAt == null);

  const totalNotes = candidates.length;
  let ok = 0;
  let notOk = 0;

  for (let i = 0; i < candidates.length; i += NOTES_CHUNK) {
    if (signal?.aborted) break;
    const chunk = candidates.slice(i, i + NOTES_CHUNK);
    const results = await Promise.allSettled(
      chunk.map(async (note) => {
        const fallbackId = note.id ?? uuidv4();
        const dto = await api.createNote({
          id: fallbackId,
          parentId: note.parentId,
          title: note.title,
          isFolder: note.isFolder ?? false,
          content: note.content,
          tags: note.tags ?? [],
          orderIdx: note.order,
        });
        await db.notes.update(note.id, {
          dirty: false,
          lastSyncedAt: Date.now(),
          version: dto.version,
        });
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else notOk++;
    }
    onProgress({ notesUploaded: ok, totalNotes });
  }

  return { ok, notOk };
}

/**
 * Bulk-upload all local attachments whose `syncStatus !== 'synced'`
 * AND `r2Key` is unset. The presign → PUT → complete trio runs in
 * sequence per attachment; chunks of 5 run in parallel.
 *
 * Returns counts. Failures are NOT marked synced — they will be
 * retried on next resume.
 */
export async function bulkUploadAttachments(
  onProgress: (p: AttachmentProgress) => void,
  signal?: AbortSignal,
): Promise<{ ok: number; notOk: number }> {
  // Pull candidate attachments (no r2Key yet → blobs still local-only).
  const candidates: Attachment[] = (await db.attachments.toArray()).filter(
    (a) => a.r2Key == null,
  );

  const totalImages = candidates.length;
  let ok = 0;
  let notOk = 0;

  for (let i = 0; i < candidates.length; i += ATTACHMENTS_CHUNK) {
    if (signal?.aborted) break;
    const chunk = candidates.slice(i, i + ATTACHMENTS_CHUNK);
    const results = await Promise.allSettled(
      chunk.map(async (att) => {
        // 1. presign — server creates an attachment row pre-uploads.
        const { attachmentId, uploadUrl } = await api.presignUpload({
          filename: att.name || `${uuidv4()}.bin`,
          mime: att.mime,
          sizeBytes: att.blob.size,
          noteId: att.noteId,
        });
        // 2. PUT directly to R2 (browser → R2, backend out of band).
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          body: att.blob,
          headers: { 'Content-Type': att.mime },
        });
        if (!putRes.ok) {
          throw new Error(`PUT ${att.id} failed: ${putRes.status}`);
        }
        // 3. complete — server marks the attachment row canonical.
        await api.completeUpload(attachmentId);
        await db.attachments.update(att.id, {
          syncStatus: 'synced',
          r2Key: `uploaded:${attachmentId}`,
        });
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else notOk++;
    }
    onProgress({ imagesUploaded: ok, totalImages });
  }

  return { ok, notOk };
}
