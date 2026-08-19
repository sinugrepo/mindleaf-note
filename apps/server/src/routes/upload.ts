import { Hono } from 'hono';
import { db } from '../db/index.js';
import { attachments, notes, tombstones } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { attachmentOwnedBy, noteOwnedBy, tombstoneOwnedBy } from '../lib/ownership.js';
import { uuidSchema } from '../lib/request-schemas.js';
import {
  s3Client,
  presignPut,
  presignGet,
  headR2Object,
  generateR2Key,
} from '../services/r2.js';
import { rateLimit } from '../middleware/ratelimit.js';
import {
  bodySizeLimit,
  UPLOAD_PRESIGN_BYTES,
} from '../middleware/body-limit.js';
import { randomUUID } from 'node:crypto';
import type {
  PresignResponse,
  AttachmentUrlResponse,
} from '@mindleaf/shared';
import {
  MAX_UPLOAD_BYTES,
  presignRequestSchema,
  isAllowedUploadMime,
} from '../lib/upload-validation.js';
import type { AppEnv } from '../config/env.js';

export const uploadRoutes = new Hono<AppEnv>();

// Phase 10 — Per-route body-size override. The presign endpoint
// receives a small JSON envelope {filename, mime, sizeBytes, noteId}
// — 1 MB is a generous ceiling (a base64 noteId alone is <100 B).
// The actual blob does NOT go through here; the browser PUTs it
// directly to R2 via the presigned URL. So 1 MB is purely a
// streaming safety net against malformed JSON bombs.
uploadRoutes.use('/presign', bodySizeLimit(UPLOAD_PRESIGN_BYTES));

// --- POST /presign ---
// Validates the upload request, creates an attachment row, and returns
// a presigned PUT URL for direct browser-to-R2 upload.
uploadRoutes.post(
  '/presign',
  rateLimit({ key: 'presign', requests: 30, windowMs: 60_000 }),
  async (c) => {
    if (!s3Client) {
      return c.json({ error: 'Object storage not configured' }, 503);
    }

    const rawBody = await c.req.json().catch(() => null);
    const parsed = presignRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const hasUnsupportedMime =
        typeof rawBody === 'object' && rawBody !== null &&
        'mime' in rawBody && typeof rawBody.mime === 'string' &&
        !isAllowedUploadMime(rawBody.mime);
      return c.json(
        { error: hasUnsupportedMime ? 'Unsupported image type' : 'Invalid upload request' },
        hasUnsupportedMime ? 400 : 422,
      );
    }
    const body = parsed.data;

    // Verify the note exists.
    const noteRows = await db
      .select()
      .from(notes)
      .where(and(eq(notes.id, body.noteId), noteOwnedBy(c.get('userId'))))
      .limit(1);
    if (noteRows.length === 0) {
      return c.json({ error: 'Note not found' }, 404);
    }

    const userId = c.get('userId');
    const attachmentId = body.attachmentId ?? randomUUID();
    const requestedR2Key = generateR2Key(userId, body.mime);

    // The browser owns the attachment UUID and embeds it in the note HTML.
    // Reusing that UUID on retries keeps IndexedDB, Postgres, and the R2
    // metadata row aligned. A lost response can therefore safely repeat
    // presign without creating an orphan row with a different id.
    // Validate ownership before touching the tombstone journal: a reused
    // ID belonging to another note must not erase that note's recovery row.
    const existingAttachment = await db
      .select({ noteId: attachments.noteId })
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), attachmentOwnedBy(c.get('userId'))))
      .limit(1);
    if (existingAttachment.length > 0 && existingAttachment[0].noteId !== body.noteId) {
      return c.json({ error: 'Attachment id is already assigned to another note' }, 409);
    }
    const ownership = await db.transaction(async (tx) => {
      await tx
        .insert(attachments)
        .values({
          id: attachmentId,
          userId: c.get('userId'),
          noteId: body.noteId,
          r2Key: requestedR2Key,
          mime: body.mime,
          name: body.filename,
          sizeBytes: body.sizeBytes,
        })
        .onConflictDoNothing();
      const stored = await tx
        .select({ noteId: attachments.noteId })
        .from(attachments)
        .where(and(eq(attachments.id, attachmentId), attachmentOwnedBy(c.get('userId'))))
        .limit(1);
      if (stored.length === 0 || stored[0].noteId !== body.noteId) {
        return false;
      }
      // A stable attachment ID may be recreated after a remote deletion.
      // Remove its old tombstone atomically only after ownership is proven.
      await tx
        .delete(tombstones)
        .where(and(
          tombstoneOwnedBy(c.get('userId')),
          eq(tombstones.resourceType, 'attachment'),
          eq(tombstones.resourceId, attachmentId),
        ));
      return true;
    });
    if (!ownership) {
      return c.json({ error: 'Attachment id is already assigned to another note' }, 409);
    }

    const rows = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), attachmentOwnedBy(c.get('userId'))))
      .limit(1);
    const stored = rows[0];
    if (!stored || stored.noteId !== body.noteId) {
      return c.json({ error: 'Attachment id is already assigned to another note' }, 409);
    }
    const r2Key = stored.r2Key ?? requestedR2Key;
    if (!stored.r2Key) {
      await db
        .update(attachments)
        .set({ r2Key, updatedAt: new Date() })
        .where(and(eq(attachments.id, attachmentId), attachmentOwnedBy(c.get('userId'))));
    }

    const uploadUrl = await presignPut(r2Key, stored.mime);

    const response: PresignResponse = {
      attachmentId,
      uploadUrl,
      r2Key,
    };
    return c.json(response);
  },
);

// --- POST /attachments/:id/complete ---
// Called by the browser after a successful PUT to R2. Confirms the
// attachment exists and records the authoritative object size via HEAD.
uploadRoutes.post('/attachments/:id/complete', async (c) => {
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) return c.json({ error: 'Invalid attachment id' }, 400);
  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), attachmentOwnedBy(c.get('userId'))))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: 'Attachment not found' }, 404);
  }
  if (!s3Client || !rows[0].r2Key) {
    return c.json({ error: 'Attachment storage is not configured' }, 503);
  }
  if (!isAllowedUploadMime(rows[0].mime)) {
    return c.json({ error: 'Attachment type is no longer allowed' }, 422);
  }

  // Confirm the object exists and record the authoritative byte count.
  // A client cannot mark an upload complete merely by calling this route.
  try {
    const head = await headR2Object(rows[0].r2Key);
    const actualSize = Number(head.ContentLength ?? -1);
    const expectedSize = rows[0].sizeBytes;
    const actualMime = head.ContentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (!Number.isFinite(actualSize) || actualSize < 0 || actualSize > MAX_UPLOAD_BYTES) {
      return c.json({ error: 'Uploaded object exceeds the size limit' }, 413);
    }
    if (expectedSize > 0 && actualSize !== expectedSize) {
      return c.json({ error: 'Uploaded object size does not match the requested size' }, 409);
    }
    if (actualMime !== rows[0].mime) {
      return c.json({ error: 'Uploaded object type does not match the requested type' }, 409);
    }
    await db
      .update(attachments)
      .set({ sizeBytes: actualSize, updatedAt: new Date() })
      .where(and(eq(attachments.id, id), attachmentOwnedBy(c.get('userId'))));
  } catch (error) {
    console.warn(`[upload] R2 object missing or unavailable for ${id}:`, error);
    return c.json({ error: 'Uploaded object could not be verified' }, 409);
  }

  return c.json({ ok: true, attachmentId: id });
});

// --- GET /attachments/:id ---
// Returns a presigned GET URL for the attachment. The browser fetches
// this to render an <img> whose src is `attachment:<id>`.
uploadRoutes.get('/attachments/:id', async (c) => {
  const id = c.req.param('id');
  if (!uuidSchema.safeParse(id).success) return c.json({ error: 'Invalid attachment id' }, 400);
  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), attachmentOwnedBy(c.get('userId'))))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: 'Attachment not found' }, 404);
  }

  const att = rows[0];
  if (!att.r2Key) {
    return c.json({ error: 'Attachment not yet uploaded' }, 409);
  }

  const url = await presignGet(att.r2Key);
  const response: AttachmentUrlResponse = {
    r2Key: att.r2Key,
    mime: att.mime,
    url,
  };
  return c.json(response);
});
