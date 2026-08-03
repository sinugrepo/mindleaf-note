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
 * Extract a rate-limit identifier from the request. Caddy overwrites
 * `X-Real-IP` and `X-Forwarded-For` before proxying to Node, so prefer
 * `X-Real-IP` and only use the final forwarded hop as a fallback. Never
 * trust the first client-supplied value in a forwarded-for chain: that
 * value is trivially spoofable and would let an attacker rotate buckets.
 */
export function getClientIp(c: Parameters<MiddlewareHandler>[0]): string {
  const real = c.req.header('x-real-ip')?.trim();
  if (real) return real;
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    const hops = fwd.split(',').map((value) => value.trim()).filter(Boolean);
    const last = hops.at(-1);
    if (last) return last;
  }
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
