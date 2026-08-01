# Mindleaf Stability Roadmap

Status: Phase 1 and selected Phase 3 hardening implemented; Phase 2 scale work remains in progress

This checklist tracks work needed to keep Mindleaf reliable as the local cache, sync queue, attachment store, and PostgreSQL database grow. The priorities below are ordered by data-integrity risk first, then performance and operations.

## Acceptance targets

- No delta-sync change is skipped because of timestamp races or equal timestamps.
- Sync can catch up after a long offline period in bounded pages without a single large response.
- Repeated offline edits to one note do not create an unbounded set of redundant pending patches.
- Two browser tabs do not concurrently drain the same queue.
- Permanent deletion is propagated to other devices through tombstones.
- Tree/search/backlink work remains bounded and is measured with scale fixtures.
- Backups have explicit size limits and a documented restore verification process.
- Production dependency and operational failures are visible before users report them.

## Phase 1 — data integrity and sync safety (P0)

- [x] Document the stability roadmap and acceptance targets.
- [x] Add a cursor-safe sync protocol with a fixed server snapshot boundary.
- [x] Paginate sync notes, attachments, and tombstones with stable `(timestamp, id)` ordering.
- [x] Make the client consume every sync page before advancing its cursor.
- [x] Add server tombstones for permanent note/attachment deletion.
- [x] Apply incoming tombstones locally and remove stale cache rows safely.
- [x] Coalesce pending `patch_note` mutations for the same note while preserving the original optimistic-lock base version.
- [x] Coordinate queue draining across tabs with Web Locks and an IndexedDB lease fallback.
- [x] Add frontend regression tests for coalescing, lock serialization, remote-missing recovery, and tree safety.
- [ ] Add server integration tests for cursor boundaries, pagination, tombstone retention, and upload verification.

**Exit checklist:** sync replay tests pass; an offline client can catch up across multiple pages; permanent deletes disappear on another client; queue size remains bounded during repeated edits.

## Phase 2 — scale the local cache and database (P1)

- [x] Add PostgreSQL indexes for sync timestamp columns (EXPLAIN verification remains a deployment task).
- [x] Replace full-table count queries with SQL aggregates.
- [x] Keep tree traversal O(N) using reusable parent/ID maps and guard malformed cycles.
- [ ] Bound local search result rendering and move large search indexes to a worker or server FTS when dataset size requires it.
- [ ] Replace full-content backlink scans with an indexed note-link table.
- [ ] Avoid loading note bodies when only tree/sidebar metadata is needed.
- [ ] Add scale fixtures for 1,000, 10,000, and 50,000 notes and measure IndexedDB query, flatten, search, and render timings.
- [ ] Add trash/tag/bulk-action pagination or bounded queries.

**Exit checklist:** large fixtures remain responsive; no user-facing operation loads all note bodies unnecessarily; query plans use the intended indexes.

## Phase 3 — attachments, backup, and operations (P1/P2)

- [x] Add attachment upload states and idempotent presign/complete reconciliation; completion now verifies the R2 object.
- [ ] Add explicit full-resync/recovery UX when a device cursor is older than the 90-day tombstone retention window.
- [ ] Reconcile metadata rows and R2 objects periodically; clean orphan objects as well as local rows.
- [ ] Convert backup export/import to bounded batches or a streaming format; support resume/checkpoints for large imports. Current implementation has 100 MB and 50,000-item guardrails.
- [ ] Add explicit per-user note, content, attachment-count, and storage quotas.
- [x] Add structured request logging and explicit warnings for sync/backup/upload failures; metrics dashboards remain deferred.
- [ ] Run an automated restore drill against a temporary database and sample attachment objects (operational task).

> Tombstones are retained for 90 days by default (`TOMBSTONE_RETENTION_DAYS`). Devices offline longer than this window require a deliberate backup/full-recovery procedure; the client must not silently discard local data.
- [x] Document dependency/security checks in the release checklist; run `npm audit` after each release (current audit result must be recorded per deployment).
- [ ] Add server route/integration tests; the server currently has no automated test suite.

**Exit checklist:** the latest backup has a verified restore result; stale queue/backup/attachment conditions are observable; large imports fail gracefully instead of exhausting VPS memory.

## Deferred architectural work

These are intentionally not part of the first stability pass because they require product and deployment decisions:

- [ ] Real-time WebSocket/SSE sync.
- [ ] CRDT or field-level collaborative editing.
- [ ] Multi-instance backend with distributed rate limiting and queue leases.
- [ ] Master encryption-key rotation and re-encryption tooling.
- [ ] Full metadata/content separation and encrypted content-on-demand API.

## Release checklist

- [x] Run web tests and typecheck.
- [x] Run server typecheck/build.
- [x] Run production frontend build and inspect chunk sizes.
- [x] Run `git diff --check`.
- [ ] Review migration/rollback impact before `db:push`.
- [ ] Take/verify a database backup before production schema changes.
- [ ] Deploy and verify `/healthz`, login, note create/edit, sync, attachment upload, trash restore, and backup export.
- [ ] Record the commit, validation output, and any known warnings.
