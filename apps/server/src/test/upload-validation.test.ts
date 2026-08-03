import { describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  presignRequestSchema,
} from '../lib/upload-validation.js';

const validRequest = {
  attachmentId: '550e8400-e29b-41d4-a716-446655440000',
  filename: 'photo.png',
  mime: 'image/png',
  sizeBytes: 1024,
  noteId: '550e8400-e29b-41d4-a716-446655440001',
};

describe('P1 upload validation', () => {
  it('accepts a bounded, supported image request', () => {
    expect(presignRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it('rejects SVG and unsupported MIME types', () => {
    expect(presignRequestSchema.safeParse({ ...validRequest, mime: 'image/svg+xml' }).success).toBe(false);
    expect(presignRequestSchema.safeParse({ ...validRequest, mime: 'text/html' }).success).toBe(false);
  });

  it('rejects invalid UUIDs, control characters, and oversized files', () => {
    expect(presignRequestSchema.safeParse({ ...validRequest, noteId: 'not-a-uuid' }).success).toBe(false);
    expect(presignRequestSchema.safeParse({ ...validRequest, filename: 'bad\u0000name.png' }).success).toBe(false);
    expect(presignRequestSchema.safeParse({ ...validRequest, sizeBytes: MAX_UPLOAD_BYTES + 1 }).success).toBe(false);
  });
});
