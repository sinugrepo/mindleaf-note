import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Server-side AES-256-GCM encryption layer.
 *
 * Single master key from the `MASTER_ENCRYPTION_KEY` environment variable
 * (base64-encoded 32 bytes). Envelope encryption is NOT used — this is a
 * single-user app and the threat model (documented in CLOUD_MIGRATION_PLAN.md
 * §1) explicitly accepts that a full VPS root compromise exposes data.
 *
 * Each note gets its own 12-byte random nonce (stored alongside the
 * ciphertext as `content_nonce`). The GCM auth tag is appended to the
 * ciphertext so `decrypt` can verify integrity in one call.
 */

const KEY = (() => {
  const raw = process.env.MASTER_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'MASTER_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32',
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `MASTER_ENCRYPTION_KEY must be 32 bytes (base64-encoded), got ${buf.length} bytes`,
    );
  }
  return buf;
})();

export interface EncryptedPayload {
  /** AES-256-GCM ciphertext + 16-byte auth tag appended. */
  ct: Buffer;
  /** 12-byte nonce (IV). */
  nonce: Buffer;
}

/**
 * Encrypt a plaintext string. Returns the ciphertext + nonce so the caller
 * can store both in the database (`content_ct` + `content_nonce` columns).
 */
export function encrypt(plaintext: string): EncryptedPayload {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, nonce);
  const ct = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Append the 16-byte GCM tag to the ciphertext so decrypt() can
  // split it back out in one shot.
  return { ct: Buffer.concat([ct, tag]), nonce };
}

/**
 * Decrypt a ciphertext + nonce pair. Throws if the auth tag verification
 * fails (tampered or wrong key) — the caller should catch and return 500.
 */
export function decrypt(ct: Buffer, nonce: Buffer): string {
  if (ct.length < 16) {
    throw new Error('decrypt: ciphertext too short (missing auth tag)');
  }
  // Split the last 16 bytes as the GCM auth tag.
  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', KEY, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
