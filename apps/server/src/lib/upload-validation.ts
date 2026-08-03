import { z } from 'zod';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * SVG is intentionally excluded: an uploaded SVG can contain active content
 * and is unsafe to render as an image without a dedicated sanitizer/CSP path.
 */
export const ALLOWED_UPLOAD_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
] as const;

export const uuidSchema = z.string().uuid();
const safeFilename = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'filename contains control characters');

export const presignRequestSchema = z.object({
  attachmentId: uuidSchema.optional(),
  filename: safeFilename,
  mime: z.enum(ALLOWED_UPLOAD_MIMES),
  sizeBytes: z.number().finite().int().positive().max(MAX_UPLOAD_BYTES),
  noteId: uuidSchema,
}).strict();

export type ValidatedPresignRequest = z.infer<typeof presignRequestSchema>;

export function isAllowedUploadMime(mime: string): mime is typeof ALLOWED_UPLOAD_MIMES[number] {
  return (ALLOWED_UPLOAD_MIMES as readonly string[]).includes(mime);
}
