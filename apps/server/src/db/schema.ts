import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  index,
  customType,
  uniqueIndex,
  foreignKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle ORM doesn't ship a built-in `bytea` column type for Postgres.
 * We define one via `customType` so we can store AES-256-GCM ciphertext
 * + nonces as raw `Buffer` objects.
 */
const bytea = customType<{
  data: Buffer;
  driverData: Buffer;
}>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Drizzle ORM doesn't ship a built-in `tsvector` column type either.
 * We define one as a customType so the search tsvector — populated by
 * the application layer at write-time (Phase 6) — round-trips cleanly
 * to Postgres. Reads return the raw tsvector string (Postgres' textual
 * serialization); we only ever INSERT/UPDATE it via `to_tsvector(...)`
 * SQL, so we never construct the value from JS directly.
 *
 * NOTE: We do NOT use a Postgres `GENERATED` column because `content_ct`
 * is encrypted ciphertext — the DB has no way to decrypt it for indexing.
 * The application layer computes plaintext → tsvector on every PATCH/POST
 * and stores it here. The matching GIN index (`notes_content_tsvector_idx`)
 * is what makes `/search?q=` fast.
 */
const tsvector = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'tsvector';
  },
});

// ---------------------------------------------------------------------------
// users — single-user app; exactly one row after setup.
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Argon2id hash of the master password. */
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// sessions — stateful server-side sessions (cookie references these rows).
// ---------------------------------------------------------------------------

export const sessions = pgTable('sessions', {
  /** UUID — also the cookie value (HMAC-signed). */
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  /** Rolling 30-day expiry; refreshed by session middleware. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Optional SHA-256 of request IP for audit / anomaly detection. */
  ipHash: text('ip_hash'),
  userAgentHash: text('user_agent_hash'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// notes — tree-structured, encrypted content, version for optimistic lock.
// ---------------------------------------------------------------------------

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** null = root-level note; otherwise self-referencing FK to parent. */
    parentId: uuid('parent_id').references((): AnyPgColumn => notes.id, {
      onDelete: 'set null',
    }),
    /** Plaintext title (for fast tree rendering + ILIKE search). */
    title: text('title').notNull().default(''),
    /** AES-256-GCM ciphertext of the TipTap HTML body. */
    contentCt: bytea('content_ct'),
    /** 12-byte nonce per note (unique per encryption). */
    contentNonce: bytea('content_nonce'),
    isFolder: boolean('is_folder').notNull().default(false),
    isExpanded: boolean('is_expanded').notNull().default(true),
    /** Manual drag-drop ordering (epoch milliseconds; PostgreSQL bigint). */
    orderIdx: bigint('order_idx', { mode: 'number' }).notNull().default(0),
    /** Normalized kebab-case tags. */
    tags: text('tags').array().notNull().default([]),
    /** Soft-delete flag (Trash feature). */
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    /** Optimistic-lock version. Increments on every successful write. */
    version: integer('version').notNull().default(1),
    /**
     * Pre-computed Postgres tsvector (`title || ' ' || plaintext(content)`)
     * used by `GET /api/search` (Phase 6). Backed by a GIN index for
     * sub-linear query latency. The application layer recomputes this on
     * every PATCH (and once on POST) — see `htmlToPlaintext` helper.
     */
    contentTsvector: tsvector('content_tsvector'),
  },
  (table) => ({
    parentIdx: index('notes_parent_idx').on(table.parentId),
    ownerIdIdx: uniqueIndex('notes_owner_id_idx').on(table.userId, table.id),
    updatedAtIdx: index('notes_updated_at_idx').on(table.updatedAt),
    deletedParentIdx: index('notes_deleted_parent_idx').on(
      table.isDeleted,
      table.parentId,
    ),
    /**
     * GIN index on the tsvector column. Powers Phase 6 FTS search
     * (`websearch_to_tsquery` + `ts_rank` ORDER BY). Without this
     * index, every `/search?q=` would do a full-table linear scan +
     * sequential tsvector parse — acceptable for hundreds of notes,
     * very slow for thousands.
     */
    contentTsvectorIdx: index('notes_content_tsvector_idx').using(
      'gin',
      table.contentTsvector,
    ),
  }),
);

// ---------------------------------------------------------------------------
// attachments — metadata for R2/MinIO objects.
// ---------------------------------------------------------------------------

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    /** R2 object key, e.g. `u/<user>/a/<uuid>.png`. */
    r2Key: text('r2_key'),
    mime: text('mime').notNull(),
    name: text('name').notNull().default(''),
    sizeBytes: integer('size_bytes').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** Changes when object metadata (key/size) becomes authoritative. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    noteIdx: index('attachments_note_idx').on(table.noteId),
    createdAtIdx: index('attachments_created_at_idx').on(table.createdAt),
    updatedAtIdx: index('attachments_updated_at_idx').on(table.updatedAt),
    ownerNoteFk: foreignKey({
      name: 'attachments_user_note_fk',
      columns: [table.userId, table.noteId],
      foreignColumns: [notes.userId, notes.id],
    }),
  }),
);

/**
 * Deletion journal consumed by delta sync. Rows remain after the source row
 * is permanently deleted so offline clients can remove their stale cache.
 */
export const tombstones = pgTable(
  'tombstones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    deletedAtIdx: index('tombstones_deleted_at_idx').on(table.deletedAt),
    resourceIdx: uniqueIndex('tombstones_resource_idx').on(table.resourceType, table.resourceId),
  }),
);

// Re-export table names for convenience in queries.
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
