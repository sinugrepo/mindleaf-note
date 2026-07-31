import { Hono } from 'hono';
import { hash, verify } from '@node-rs/argon2';
import { db } from '../db/index.js';
import { users, sessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  setSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
} from '../middleware/auth.js';
import { getCookie } from 'hono/cookie';
import { rateLimit } from '../middleware/ratelimit.js';
import type { AppEnv } from '../env.js';

export const authRoutes = new Hono<AppEnv>();

// --- POST /login ---
// Verifies the password against the Argon2id hash in the `users` table,
// creates a session row, and sets an HttpOnly + SameSite=Strict cookie.
// Rate-limited to 5 attempts per 15 minutes per IP.
authRoutes.post(
  '/login',
  rateLimit({ key: 'login', requests: 5, windowMs: 15 * 60_000 }),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.password !== 'string') {
      return c.json({ error: 'Password is required' }, 400);
    }

    // Fetch the single user row (single-user app).
    const userRows = await db.select().from(users).limit(1);
    if (userRows.length === 0) {
      return c.json({ error: 'No account found. Run the seed script first.' }, 404);
    }
    const user = userRows[0];

    const isValid = await verify(user.passwordHash, body.password);
    if (!isValid) {
      return c.json({ error: 'Invalid password' }, 401);
    }

    // Create a new session.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const [session] = await db
      .insert(sessions)
      .values({
        userId: user.id,
        expiresAt,
        createdAt: now,
        lastSeenAt: now,
      })
      .returning({ id: sessions.id });

    setSessionCookie(c, session.id);
    return c.json({ ok: true });
  },
);

// --- POST /logout ---
// Deletes the session row and clears the cookie.
authRoutes.post('/logout', async (c) => {
  const cookieValue = getCookie(c, SESSION_COOKIE);
  if (cookieValue) {
    // Extract session ID from the signed cookie and delete the row.
    const dotIdx = cookieValue.indexOf('.');
    if (dotIdx !== -1) {
      const sessionId = cookieValue.slice(dotIdx + 1);
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    }
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// --- POST /setup ---
// One-time setup: creates the single user row with the master password.
// Returns 409 if a user already exists (prevents re-setting the password
// without auth). Rate-limited to prevent abuse.
authRoutes.post(
  '/setup',
  rateLimit({ key: 'setup', requests: 3, windowMs: 60 * 60_000 }),
  async (c) => {
  const existing = await db.select().from(users).limit(1);
  if (existing.length > 0) {
    return c.json({ error: 'Account already exists' }, 409);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.password !== 'string' || body.password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }

  // OWASP-recommended Argon2id parameters.
  // Algorithm.Argon2id = 2 (can't use the enum directly with isolatedModules).
  const passwordHash = await hash(body.password, {
    algorithm: 2, // Argon2id
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 4,
  });

    await db.insert(users).values({ passwordHash });
    return c.json({ ok: true });
  },
);
