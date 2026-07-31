import type { MiddlewareHandler } from 'hono';

/**
 * In-memory token-bucket rate limiter.
 *
 * Redis-free — acceptable for a single-user backend where the server
 * runs as one process. The bucket is keyed by a caller-supplied string
 * (typically the client IP for /auth/login, or the session ID for
 * upload presign).
 *
 * Usage:
 *   app.post('/auth/login', rateLimit({ key: 'login', requests: 5, windowMs: 15 * 60_000 }), handler)
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Prefix for the bucket key (e.g. 'login'). The actual key is `${prefix}:${ipOrId}`. */
  key: string;
  /** Maximum requests in the window. */
  requests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/**
 * Extract a rate-limit identifier from the request. Prefers the
 * `X-Forwarded-For` header (behind Caddy), falls back to the Hono
 * `c.req.header('x-real-ip')`, then to a constant (for local dev
 * where no proxy headers are present).
 */
function getClientIp(c: Parameters<MiddlewareHandler>[0]): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  const real = c.req.header('x-real-ip');
  if (real) return real;
  return '127.0.0.1';
}

/**
 * Create a rate-limit middleware. Returns 429 with a `Retry-After` header
 * when the bucket is exhausted.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const ip = getClientIp(c);
    const bucketKey = `${opts.key}:${ip}`;
    const now = Date.now();

    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { tokens: opts.requests, lastRefill: now };
      buckets.set(bucketKey, bucket);
    }

    // Refill tokens proportional to elapsed time.
    const elapsed = now - bucket.lastRefill;
    const refillCount = Math.floor((elapsed / opts.windowMs) * opts.requests);
    if (refillCount > 0) {
      bucket.tokens = Math.min(opts.requests, bucket.tokens + refillCount);
      bucket.lastRefill = now;
    }

    if (bucket.tokens <= 0) {
      const retryAfterSec = Math.ceil(opts.windowMs / 1000);
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        { error: 'Too many requests. Please try again later.' },
        429,
      );
    }

    bucket.tokens -= 1;
    await next();
  };
}
