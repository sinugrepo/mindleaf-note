import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { lt } from 'drizzle-orm';
import {
  users,
  sessions,
  notes,
  attachments,
  tombstones,
} from './schema.js';

/**
 * Postgres connection. `postgres-js` creates a connection pool internally.
 * The `max` option is kept low because this is a single-user backend —
 * one connection is usually enough, but we allow 5 for concurrent
 * sync/CRUD calls.
 */
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy apps/server/.env.example to .env and fill in the values.',
  );
}

const queryClient = postgres(connectionString, { max: 5 });

export const db = drizzle(queryClient, {
  schema: { users, sessions, notes, attachments, tombstones },
});

/**
 * Export the raw postgres-js client for raw SQL (recursive CTEs, tsvector).
 * Named `pgClient` (not `sql`) to avoid shadowing Drizzle's `sql` helper
 * when both are imported in the same file.
 */
export { queryClient as pgClient };

/**
 * Remove deletion-journal rows only after the configured offline recovery
 * window. Clients that remain offline longer than this window cannot receive
 * historical tombstones and must recover from a fresh backup/full snapshot.
 */
export const TOMBSTONE_RETENTION_DAYS = Number.parseInt(
  process.env.TOMBSTONE_RETENTION_DAYS ?? '90',
  10,
);

export async function purgeExpiredTombstones(): Promise<number> {
  const days = Number.isFinite(TOMBSTONE_RETENTION_DAYS) && TOMBSTONE_RETENTION_DAYS > 0
    ? TOMBSTONE_RETENTION_DAYS
    : 90;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(tombstones)
    .where(lt(tombstones.deletedAt, cutoff))
    .returning({ id: tombstones.id });
  return deleted.length;
}
