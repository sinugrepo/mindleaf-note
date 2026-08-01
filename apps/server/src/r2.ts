import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

/**
 * S3-compatible object storage client.
 *
 * In production this points to Cloudflare R2 (zero egress fees).
 * In local dev it points to MinIO (started via `docker compose up`).
 *
 * The client is a singleton — AWS SDK reuses HTTP connections
 * internally so we don't pay a TLS handshake per request.
 */

const endpoint = process.env.R2_ENDPOINT;
const accessKey = process.env.R2_ACCESS_KEY;
const secretKey = process.env.R2_SECRET_KEY;
const bucket = process.env.R2_BUCKET ?? 'mindleaf-dev';
const region = process.env.R2_REGION ?? 'auto';

if (!endpoint || !accessKey || !secretKey) {
  // Don't throw at import time — the seed script and healthz should
  // work even without R2 configured. Routes that need R2 will throw
  // at call time if the client is missing.
  console.warn(
    '[R2] R2_ENDPOINT, R2_ACCESS_KEY, or R2_SECRET_KEY not set. Upload/download routes will fail until configured.',
  );
}

export const s3Client = endpoint
  ? new S3Client({
      region,
      endpoint,
      credentials: {
        accessKeyId: accessKey!,
        secretAccessKey: secretKey!,
      },
      // MinIO and R2 both work better with path-style addressing.
      forcePathStyle: true,
    })
  : null;

export const R2_BUCKET = bucket;

/** Presigned PUT URL TTL: 5 minutes (enough for a browser upload). */
const PUT_TTL_SEC = 5 * 60;

/** Presigned GET URL TTL: 10 minutes (short to limit URL leak via history). */
const GET_TTL_SEC = 10 * 60;

/**
 * Generate an R2 object key for a new attachment.
 * Format: `u/<userIdShort>/a/<uuid>.<ext>`
 */
export function generateR2Key(userId: string, mime: string): string {
  const uuid = randomUUID();
  const ext = mimeToExtension(mime);
  const userShort = userId.slice(0, 8);
  return `u/${userShort}/a/${uuid}.${ext}`;
}

/**
 * Create a presigned PUT URL for direct browser-to-R2 upload.
 */
export async function presignPut(r2Key: string): Promise<string> {
  if (!s3Client) throw new Error('R2 client not configured');
  const command = new PutObjectCommand({ Bucket: R2_BUCKET, Key: r2Key });
  return getSignedUrl(s3Client, command, { expiresIn: PUT_TTL_SEC });
}

/**
 * Create a presigned GET URL for browser rendering of an attachment.
 */
export async function presignGet(r2Key: string): Promise<string> {
  if (!s3Client) throw new Error('R2 client not configured');
  const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key });
  return getSignedUrl(s3Client, command, { expiresIn: GET_TTL_SEC });
}

/**
 * Fetch an object from R2 for server-side backup export.
 * Keep SDK command execution in the storage module rather than routes.
 */
export async function getR2Object(r2Key: string) {
  if (!s3Client) throw new Error('R2 client not configured');
  const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key });
  return s3Client.send(command);
}

/**
 * Map a MIME type to a file extension for the R2 key. Falls back to `bin`.
 */
function mimeToExtension(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
  };
  return map[mime] ?? 'bin';
}
