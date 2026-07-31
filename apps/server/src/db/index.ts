import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  users,
  sessions,
  notes,
  attachments,
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
  schema: { users, sessions, notes, attachments },
});

/**
 * Export the raw postgres-js client for raw SQL (recursive CTEs, tsvector).
 * Named `pgClient` (not `sql`) to avoid shadowing Drizzle's `sql` helper
 * when both are imported in the same file.
 */
export { queryClient as pgClient };
