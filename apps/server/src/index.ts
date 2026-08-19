import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { purgeExpiredTombstones, TOMBSTONE_RETENTION_DAYS } from './db/index.js';

const app = createApp();

// Keep the deletion journal bounded, but retain it long enough for normal
// offline devices to reconnect. This is intentionally a best-effort single
// instance job; a future multi-instance deployment should move it to a
// database scheduler/advisory-lock job.
const tombstoneCleanupTimer = setInterval(() => {
  void purgeExpiredTombstones()
    .then((count) => {
      if (count > 0) console.log(`[sync] purged ${count} tombstone(s)`);
    })
    .catch((error) => console.warn('[sync] tombstone cleanup failed:', error));
}, 24 * 60 * 60 * 1000);
tombstoneCleanupTimer.unref?.();
void purgeExpiredTombstones().catch((error) => {
  console.warn(
    `[sync] initial tombstone cleanup failed (retention=${TOMBSTONE_RETENTION_DAYS}d):`,
    error,
  );
});

const port = parseInt(process.env.PORT ?? '8787', 10);
const hostname = process.env.HOST ?? '127.0.0.1';

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`🌿 Mindleaf backend listening on http://${hostname}:${info.port}`);
});

export type App = typeof app;
