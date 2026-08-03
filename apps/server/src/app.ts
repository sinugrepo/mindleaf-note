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
import { count, eq } from 'drizzle-orm';
import type { AppEnv } from './env.js';

/**
 * Build the HTTP application without binding a TCP listener. Keeping this
 * separate from the production entrypoint lets Vitest exercise real routes
 * through Hono's standard app.request() helper.
 */
export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', pinoLogger());
  const defaultBodyLimit = bodySizeLimit(DEFAULT_API_BYTES);
  // The import route has its own 150 MB streaming limit. It must bypass the
  // default 5 MB guard here because middleware is evaluated in registration
  // order; a later route middleware cannot enlarge an already-consumed limit.
  app.use('*', async (c, next) => {
    if (c.req.path === '/api/backup/import/full') return next();
    return defaultBodyLimit(c, next);
  });
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
      credentials: true,
    }),
  );

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/api/auth', authRoutes);
  app.use('/api/*', sessionMiddleware);
  app.route('/api/notes', notesRoutes);
  app.route('/api/upload', uploadRoutes);
  app.route('/api/search', searchRoutes);
  app.route('/api/sync', syncRoutes);
  app.route('/api/backup', backupRoutes);

  app.get('/api/me/info', async (c) => {
    const userRow = await db.select().from(users).limit(1);
    if (userRow.length === 0) {
      return c.json({ createdAt: 0, noteCount: 0 });
    }
    const [{ noteCount }] = await db
      .select({ noteCount: count() })
      .from(notes)
      .where(eq(notes.isDeleted, false));
    return c.json({
      createdAt: userRow[0].createdAt.getTime(),
      noteCount: Number(noteCount),
    });
  });

  app.onError((err, c) => {
    console.error('[unhandled]', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
