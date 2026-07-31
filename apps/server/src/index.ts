import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import { authRoutes } from './routes/auth.js';
import { notesRoutes } from './routes/notes.js';
import { uploadRoutes } from './routes/upload.js';
import { searchRoutes } from './routes/search.js';
import { syncRoutes } from './routes/sync.js';
import { backupRoutes } from './routes/backup.js';
import { sessionMiddleware } from './middleware/auth.js';
import { pinoLogger } from './middleware/logger.js';
import { bodySizeLimit, DEFAULT_API_BYTES } from './middleware/body-limit.js';
import { db } from './db/index.js';
import { users, notes } from './db/schema.js';
import { eq } from 'drizzle-orm';
import type { AppEnv } from './env.js';

const app = new Hono<AppEnv>();

// --- Global middleware (order matters) ---
// Phase 10 — Pino access logger replaces hono/logger. Structural JSON
// to stdout (prod) or pino-pretty (dev). Cookies + Authorization
// headers are redacted at the pino-formatter level, never in
// route handlers. MUST run first so requestId is set before any
// downstream middleware (including secureHeaders) logs anything.
app.use('*', pinoLogger());

// Phase 10 — Global request body cap. 5 MB is plenty for any single
// JSON API call (a 10-KB note with 50 KB of compressed image
// metadata tops out at ~1 MB after base64 expansion). Streaming
// chunk counter, not Content-Length header — a misbehaving client
// can't lie past the limit. Routes that legitimately need larger
// bodies (backup import = 150 MB) override per-route below.
app.use('*', bodySizeLimit(DEFAULT_API_BYTES));

// Hono's `secureHeaders` middleware is now intentionally MINIMAL —
// Caddy (deploy/Caddyfile) is the single source of truth for security
// headers in production, applied via its site-level `header {}` block
// to EVERY response (SPA + /api + /healthz). We disable the headers
// Hono otherwise emits by default so /api/* responses don't carry
// DOUBLE headers in prod (browsers pick the stricter today, but a
// single source of truth is cleaner).
//
// Trade-off: dev mode (no Caddy in front, Vite proxy → :8787) loses
// these headers entirely. Acceptable — dev runs on localhost without
// HTTPS, so hsts/referrer/permissions are non-mandatory there. nosniff
// + x-frame-options are nice-to-have but our SPA has no foreign
// iframes / unforeseen mime-sniffing attack vectors that we'd need to
// defend against on dev.
//
// `permissionsPolicy` is shaped differently from the others — Hono's
// type is `Partial<Record<PermissionsPolicyDirective, ...>>`, an
// OBJECT of directive → value mappings, NOT a simple boolean. Passing
// `{}` lets Hono's runtime (which iterates Record entries to build
// the header) emit nothing — equivalent to "disable the header".
//
// Deferred to Caddy (NOT duplicated here): CSP + HSTS + nosniff +
// X-Frame-Options + Referrer-Policy + Permissions-Policy.
app.use(
  '*',
  secureHeaders({
    strictTransportSecurity: false,
    xContentTypeOptions: false,
    xFrameOptions: false,
    referrerPolicy: false,
    permissionsPolicy: {},
  }),
);
app.use(
  '/api/*',
  cors({
    origin: process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000',
    credentials: true, // HttpOnly cookie needs `credentials: 'include'`
  }),
);

// --- Health check (no auth required) ---
app.get('/healthz', (c) => c.json({ ok: true }));

// --- API routes ---
// Auth routes don't require a session — they CREATE one.
app.route('/api/auth', authRoutes);

// All other /api routes require a valid session cookie.
app.use('/api/*', sessionMiddleware);
app.route('/api/notes', notesRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/sync', syncRoutes);
// Phase 7 — backup (export/import) routes.
app.route('/api/backup', backupRoutes);

// --- Me info (requires session, mounted at /api/me) ---
app.get('/api/me/info', async (c) => {
  const userRow = await db.select().from(users).limit(1);
  if (userRow.length === 0) {
    return c.json({ createdAt: 0, noteCount: 0 });
  }
  // Count only active (non-deleted) notes.
  const activeNoteRows = await db
    .select()
    .from(notes)
    .where(eq(notes.isDeleted, false));
  return c.json({
    createdAt: userRow[0].createdAt.getTime(),
    noteCount: activeNoteRows.length,
  });
});

// --- Centralized error handler ---
// Catches unhandled exceptions (e.g. decryption errors) so we return
// a clean 500 instead of leaking stack traces to the client. Logs the
// error server-side for debugging.
app.onError((err, c) => {
  console.error('[unhandled]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

const port = parseInt(process.env.PORT ?? '8787', 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🌿 Mindleaf backend listening on http://localhost:${info.port}`);
});

// Export the app type for Hono RPC on the frontend.
export type App = typeof app;
