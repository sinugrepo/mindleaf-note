import { bodyLimit } from 'hono/body-limit';

/**
 * Phase 10 — Per-route body-size limit, expressed as bytes.
 *
 * Hono's built-in `bodyLimit` is a streaming chunk counter that
 * rejects oversized payloads at chunk boundary without buffering
 * the whole request (so a malicious 9 GB upload can't OOM the
 * 1 GB VPS). The middleware is part of the `hono` package itself
 * (NOT a separate `@hono/body-limit` package on npm — that one
 * does not exist; this split is kept inside core).
 *
 * Constants chosen to match:
 *   - DEFAULT_API_BYTES = 5 MB  (auth + CRUD JSON bodies)
 *   - BACKUP_IMPORT_BYTES = 150 MB (matches MAX_EXPORT_TOTAL_BYTES;
 *     import budget is intentionally one-sided since the server
 *     does in-memory AES encryption of every note's plaintext)
 *   - UPLOAD_PRESIGN_BYTES = 1 MB  (just the JSON describing the
 *     upload; the actual blob goes browser→R2 direct via presigned)
 *
 * Note: upload.ts already enforces MAX_UPLOAD_BYTES = 5 MB inside
 * its handler (because file size is supplied by the client and we
 * want a 4xx with a friendly error message). The body-limit here is
 * a streaming safety net ABOVE that — anything past 1 MB can't even
 * be a legitimate presign request and gets nuked immediately.
 */

export const DEFAULT_API_BYTES = 5 * 1024 * 1024; // 5 MB
export const BACKUP_IMPORT_BYTES = 150 * 1024 * 1024; // 150 MB
export const UPLOAD_PRESIGN_BYTES = 1 * 1024 * 1024; // 1 MB

/**
 * Convenience re-export: route files write
 *   uploadRoutes.use('/presign', bodySizeLimit(UPLOAD_PRESIGN_BYTES))
 * without needing a separate `hono/body-limit` import.
 */
export const bodySizeLimit = (maxBytes: number) => bodyLimit({ maxSize: maxBytes });
