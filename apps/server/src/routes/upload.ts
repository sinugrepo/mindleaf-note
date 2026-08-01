import { Hono } from 'hono';
import { db } from '../db/index.js';
import { attachments, notes } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  s3Client,
  presignPut,
  presignGet,
  generateR2Key,
} from '../r2.js';
import { rateLimit } from '../middleware/ratelimit.js';
import {
  bodySizeLimit,
  UPLOAD_PRESIGN_BYTES,
} from '../middleware/body-limit.js';
import { randomUUID } from 'node:crypto';
import type {
  PresignRequest,
  PresignResponse,
  AttachmentUrlResponse,
} from '@mindleaf/shared';
import type { AppEnv } from '../env.js';

export const uploadRoutes = new Hono<AppEnv>();

/** Max upload size: 5 MB. Matches the plan's limit. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Phase 10 — Per-route body-size override. The presign endpoint
// receives a small JSON envelope {filename, mime, sizeBytes, noteId}
// — 1 MB is a generous ceiling (a base64 noteId alone is <100 B).
// The actual blob does NOT go through here; the browser PUTs it
// directly to R2 via the presigned URL. So 1 MB is purely a
// streaming safety net against malformed JSON bombs.
uploadRoutes.use('/presign', bodySizeLimit(UPLOAD_PRESIGN_BYTES));

/** Allowed image MIME types. */
const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
]);

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

    const body = await c.req.json().catch(() => null) as PresignRequest | null;
    if (!body || !body.filename || !body.mime || !body.noteId) {
      return c.json({ error: 'filename, mime, and noteId are required' }, 400);
    }

    if (!ALLOWED_MIMES.has(body.mime)) {
      return c.json({ error: `Unsupported file type: ${body.mime}` }, 400);
    }

    if (body.sizeBytes > MAX_UPLOAD_BYTES) {
      return c.json(
        { error: `File too large. Max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` },
        413,
      );
    }

    // Verify the note exists.
    const noteRows = await db
      .select()
      .from(notes)
      .where(eq(notes.id, body.noteId))
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
    await db
      .insert(attachments)
      .values({
        id: attachmentId,
        noteId: body.noteId,
        r2Key: requestedR2Key,
        mime: body.mime,
        name: body.filename,
        sizeBytes: body.sizeBytes,
      })
      .onConflictDoNothing();

    const rows = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    const stored = rows[0];
    if (!stored || stored.noteId !== body.noteId) {
      return c.json({ error: 'Attachment id is already assigned to another note' }, 409);
    }
    const r2Key = stored.r2Key ?? requestedR2Key;
    if (!stored.r2Key) {
      await db
        .update(attachments)
        .set({ r2Key })
        .where(eq(attachments.id, attachmentId));
    }

    const uploadUrl = await presignPut(r2Key);

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
// attachment is uploaded. (In V1 we trust the client's confirmation;
// a future enhancement could HEAD the R2 object to verify.)
uploadRoutes.post('/attachments/:id/complete', async (c) => {
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: 'Attachment not found' }, 404);
  }

  // The r2Key was already set at presign time; nothing to update
  // here in V1. Return the confirmed attachment.
  return c.json({ ok: true, attachmentId: id });
});

// --- GET /attachments/:id ---
// Returns a presigned GET URL for the attachment. The browser fetches
// this to render an <img> whose src is `attachment:<id>`.
uploadRoutes.get('/attachments/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
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
