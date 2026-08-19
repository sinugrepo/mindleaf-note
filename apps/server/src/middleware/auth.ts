import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { eq, and, gt } from 'drizzle-orm';
import type { AppEnv } from '../config/env.js';

/**
 * Session cookie name. The cookie value is `<base64(hmac)>.<session_id>`
 * so an attacker who can read the cookie (e.g. via a non-HttpOnly leak)
 * still can't forge a different session_id without the SESSION_SECRET.
 */
export const SESSION_COOKIE = 'sid';

/**
 * Session TTL: 30 days. The middleware rolls the expiry forward when
 * more than 50% of the TTL has elapsed, so active users never get
 * logged out.
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ROLL_THRESHOLD_MS = SESSION_TTL_MS / 2;

const SECRET = (() => {
  const raw = process.env.SESSION_SECRET;
  if (!raw) {
    throw new Error(
      'SESSION_SECRET is not set. Generate one with: openssl rand -base64 32',
    );
  }
  return raw;
})();

/**
 * Sign a session ID with HMAC-SHA256. Returns `base64(hmac).sessionId`.
 */
function signSessionId(sessionId: string): string {
  const mac = createHmac('sha256', SECRET).update(sessionId).digest('base64url');
  return `${mac}.${sessionId}`;
}

/**
 * Verify the HMAC signature on a cookie value. Returns the session ID
 * if valid, or null if the signature doesn't match / the format is wrong.
 */
function verifyAndExtractSessionId(cookieValue: string): string | null {
  const dotIdx = cookieValue.indexOf('.');
  if (dotIdx === -1) return null;
  const providedMac = cookieValue.slice(0, dotIdx);
  const sessionId = cookieValue.slice(dotIdx + 1);
  if (!sessionId) return null;

  const expectedMac = createHmac('sha256', SECRET)
    .update(sessionId)
    .digest('base64url');

  // Timing-safe comparison to prevent MAC oracle attacks.
  const a = Buffer.from(providedMac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  return sessionId;
}

/**
 * Set the session cookie on the response. HttpOnly + Secure (in prod) +
 * SameSite=Strict + 30-day Max-Age.
 */
export function setSessionCookie(c: Context<AppEnv>, sessionId: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  setCookie(c, SESSION_COOKIE, signSessionId(sessionId), {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Strict',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/**
 * Clear the session cookie (logout).
 */
export function clearSessionCookie(c: Context<AppEnv>): void {
  setCookie(c, SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    path: '/',
    maxAge: 0,
  });
}

/**
 * Session middleware. Parses the cookie, verifies the HMAC, looks up
 * the session row, checks expiry, and attaches `c.set('userId', ...)`.
 *
 * If the session is more than 50% through its TTL, the expiry is rolled
 * forward (rolling session).
 *
 * Returns 401 if no valid session is found.
 */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cookieValue = getCookie(c, SESSION_COOKIE);
  if (!cookieValue) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const sessionId = verifyAndExtractSessionId(cookieValue);
  if (!sessionId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const now = new Date();
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
    .limit(1);

  if (sessionRows.length === 0) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const session = sessionRows[0];

  // Attach the user ID to the context for downstream handlers.
  c.set('userId', session.userId);

  // Rolling expiry: if more than 50% of the TTL has elapsed, push the
  // expiry forward. This avoids logging out active users.
  const msRemaining = session.expiresAt.getTime() - now.getTime();
  if (msRemaining < SESSION_ROLL_THRESHOLD_MS) {
    const newExpiry = new Date(now.getTime() + SESSION_TTL_MS);
    await db
      .update(sessions)
      .set({ expiresAt: newExpiry, lastSeenAt: now })
      .where(eq(sessions.id, sessionId));
  } else {
    // Just update lastSeenAt (lightweight touch).
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));
  }

  await next();
};
