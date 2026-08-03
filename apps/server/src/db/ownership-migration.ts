import postgres from 'postgres';

const OWNED_TABLES = ['notes', 'attachments', 'tombstones'] as const;

type OwnedTable = typeof OWNED_TABLES[number];

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Prepare ownership columns for an existing single-user database.
 *
 * The schema declares these columns NOT NULL. This preflight migration adds
 * them as nullable, backfills every legacy row to the oldest user, then makes
 * them NOT NULL. Fresh databases have no legacy tables/rows and are left for
 * Drizzle to create normally.
 */
export async function prepareOwnershipMigration(
  connectionString = process.env.NODE_ENV === 'test'
    ? (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL)
    : process.env.DATABASE_URL,
): Promise<void> {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const sql = postgres(connectionString, { max: 1 });
  try {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users', 'notes', 'attachments', 'tombstones')
    `;
    const existingTables = new Set(tables.map((row) => row.table_name));
    if (!existingTables.has('users')) return;

    const userRows = await sql<{ id: string }[]>`
      SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1
    `;
    const ownerId = userRows[0]?.id ?? null;

    for (const table of OWNED_TABLES) {
      if (!existingTables.has(table)) continue;
      const identifier = quoteIdentifier(table);
      const columns = await sql<{ column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'user_id'
      `;
      if (columns.length === 0) {
        await sql.unsafe(`ALTER TABLE ${identifier} ADD COLUMN user_id uuid`);
      }
      if (table === 'attachments') {
        const updatedColumns = await sql<{ column_name: string }[]>`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'updated_at'
        `;
        if (updatedColumns.length === 0) {
          await sql.unsafe(`ALTER TABLE ${identifier} ADD COLUMN updated_at timestamptz`);
        }
        await sql.unsafe(
          `UPDATE ${identifier} SET updated_at = COALESCE(updated_at, created_at, now()) WHERE updated_at IS NULL`,
        );
        await sql.unsafe(`ALTER TABLE ${identifier} ALTER COLUMN updated_at SET DEFAULT now()`);
        await sql.unsafe(`ALTER TABLE ${identifier} ALTER COLUMN updated_at SET NOT NULL`);
        await sql.unsafe(`CREATE INDEX IF NOT EXISTS "attachments_updated_at_idx" ON ${identifier} (updated_at)`);
      }
      const [{ count }] = await sql.unsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM ${identifier}`,
      );
      if (Number(count) > 0 && !ownerId) {
        throw new Error(`Cannot backfill ${table}.user_id: users table has no owner`);
      }
      if (ownerId) {
        await sql.unsafe(
          `UPDATE ${identifier} SET user_id = $1 WHERE user_id IS NULL`,
          [ownerId],
        );
      }
      await sql.unsafe(`ALTER TABLE ${identifier} ALTER COLUMN user_id SET NOT NULL`);
      await sql.unsafe(
        `DO $$ BEGIN
           IF NOT EXISTS (
             SELECT 1 FROM pg_constraint WHERE conname = '${table}_user_id_users_fk'
           ) THEN
             ALTER TABLE ${identifier} ADD CONSTRAINT "${table}_user_id_users_fk"
               FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
           END IF;
         END $$;`,
      );
      await sql.unsafe(`CREATE INDEX IF NOT EXISTS "${table}_user_id_idx" ON ${identifier} (user_id)`);
    }

    if (existingTables.has('notes') && existingTables.has('attachments')) {
      await sql.unsafe(
        'CREATE UNIQUE INDEX IF NOT EXISTS "notes_owner_id_idx" ON "notes" (user_id, id)',
      );
      await sql.unsafe(
        `DO $$ BEGIN
           IF NOT EXISTS (
             SELECT 1 FROM pg_constraint WHERE conname = 'attachments_user_note_fk'
           ) THEN
             ALTER TABLE "attachments" ADD CONSTRAINT "attachments_user_note_fk"
               FOREIGN KEY (user_id, note_id) REFERENCES "notes" (user_id, id)
               ON DELETE CASCADE;
           END IF;
         END $$;`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  prepareOwnershipMigration()
    .then(() => console.log('ownership migration prepared'))
    .catch((error) => {
      console.error('ownership migration failed:', error);
      process.exitCode = 1;
    });
}
