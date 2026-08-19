import { Hono } from 'hono';
import { db, pgClient } from '../db/index.js';
import { notes } from '../db/schema.js';
import { sql } from 'drizzle-orm';
import { decrypt } from '../services/crypto.js';
import { searchQuerySchema } from '../lib/request-schemas.js';
import type { NoteDTO } from '@mindleaf/shared';
import type { AppEnv } from '../config/env.js';

export const searchRoutes = new Hono<AppEnv>();

/**
 * Phase 6 — Full-text search via Postgres `tsvector` (Serving 2/3 of
 * the migration plan's "V2 implementation: ... Phase 6 per the
 * migration plan, which uses Postgres tsvector + GIN" remark).
 *
 * Strategy:
 *   1. The application layer (notes.ts) recomputes a `content_tsvector`
 *      column on every PATCH/POST, computed from `title || ' ' ||
 *      plaintext(content)`. The column is backed by a GIN index for
 *      sub-linear query latency.
 *   2. We use `websearch_to_tsquery('simple', $q)`, which supports
 *      Google-style syntax: bare words (AND), "quoted phrases",
 *      `or`, and `-exclude`. The simplest thing to expose to users.
 *   3. We rank with `ts_rank` (higher = better match) and tie-break on
 *      `updated_at DESC` so recent edits float up.
 *
 * Failure mode for malformed queries: `websearch_to_tsquery` raises
 * a `syntax error in tsquery` for invalid input. We catch it and
 * return an empty result set rather than 500-ing the client.
 *
 * Response shape: a list of decrypted NoteDTOs, identical to the
 * Phase 1 ILIKE response so the client (`SearchResults.tsx`) does
 * not need to know which backend search runs underneath.
 */
searchRoutes.get('/', async (c) => {
  const parsedQuery = searchQuerySchema.safeParse({ q: c.req.query('q') });
  if (!parsedQuery.success) return c.json({ error: 'Invalid search query' }, 400);
  const q = parsedQuery.data.q;
  if (!q) {
    return c.json([]);
  }

  // Pull the ranked + filtered set of note rows directly via raw
  // postgres-js: this is the one place where the Drizzle query
  // builder gets in the way of `to_tsquery + ts_rank` ergonomics.
  // Parameter binding is done via tagged-template placeholders so
  // user input is safe from SQL injection.
  type RankedRow = {
    id: string;
    parent_id: string | null;
    title: string;
    content_ct: Buffer | null;
    content_nonce: Buffer | null;
    is_folder: boolean;
    is_expanded: boolean;
    order_idx: number;
    tags: string[] | null;
    is_deleted: boolean;
    deleted_at: Date | null;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  let rows: RankedRow[];
  try {
    rows = (await pgClient`
      SELECT
        id, parent_id, title, content_ct, content_nonce,
        is_folder, is_expanded, order_idx, tags,
        is_deleted, deleted_at, created_at, updated_at, version
      FROM notes
      WHERE is_deleted = false
        AND user_id = ${(c.get('userId'))}::uuid
        AND content_tsvector @@ websearch_to_tsquery('simple', ${q})
      ORDER BY ts_rank(content_tsvector, websearch_to_tsquery('simple', ${q})) DESC,
               updated_at DESC
      LIMIT 50
    `) as RankedRow[];
  } catch (err) {
    // Invalid tsquery syntax (rare — `websearch_to_tsquery` is more
    // forgiving than `plainto_tsquery`). Return an empty list rather
    // than 500. The frontend shows "No notes found".
    if (
      err instanceof Error &&
      /syntax error in tsquery/i.test(err.message)
    ) {
      return c.json([]);
    }
    throw err;
  }

  const dtos: NoteDTO[] = rows.map((r) => {
    let content = '';
    try {
      content =
        r.content_ct && r.content_nonce
          ? decrypt(r.content_ct, r.content_nonce)
          : '';
    } catch {
      console.error(`[search] Failed to decrypt note ${r.id}`);
    }
    return {
      id: r.id,
      parentId: r.parent_id,
      title: r.title,
      content,
      isFolder: r.is_folder,
      isExpanded: r.is_expanded,
      orderIdx: r.order_idx,
      tags: r.tags ?? [],
      deletedAt: r.deleted_at ? r.deleted_at.getTime() : null,
      createdAt: r.created_at.getTime(),
      updatedAt: r.updated_at.getTime(),
      version: r.version,
    };
  });

  return c.json(dtos);
});
