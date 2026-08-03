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
- [x] Bound local search result rendering to 100 results and make search breadcrumbs O(1) per parent lookup; move the full-text index to a worker/server FTS when dataset size requires it.
- [ ] Replace full-content backlink scans with an indexed note-link table; current scan streams IndexedDB rows to reduce peak memory.
- [ ] Avoid loading note bodies when only tree/sidebar metadata is needed.
- [ ] Add scale fixtures for 1,000, 10,000, and 50,000 notes and measure IndexedDB query, flatten, search, and render timings.
- [x] Stream tag catalogue/backlink/search candidate scans and cap rendered search results to protect peak memory.
- [ ] Add trash/tag/bulk-action pagination or bounded queries.

**Exit checklist:** large fixtures remain responsive; no user-facing operation loads all note bodies unnecessarily; query plans use the intended indexes.

## Phase 3 — attachments, backup, and operations (P1/P2)

- [x] Add attachment upload states and idempotent presign/complete reconciliation; completion now verifies the R2 object.
- [x] Detect an expired sync cursor and persist a visible `Recovery required` gate without silently deleting local data.
- [ ] Add explicit full-resync/recovery UX when a device cursor is older than the 90-day tombstone retention window.
- [ ] Reconcile metadata rows and R2 objects periodically; clean orphan objects as well as local rows.
- [ ] Convert backup export/import to bounded batches or a streaming format; support resume/checkpoints for large imports. Current implementation has 100 MB and 50,000-item guardrails.
- [ ] Add explicit per-user note, content, attachment-count, and storage quotas.
- [x] Add structured request logging and explicit warnings for sync/backup/upload failures; metrics dashboards remain deferred.
- [ ] Run an automated restore drill against a temporary database and sample attachment objects (operational task).

> Tombstones are retained for 90 days by default (`TOMBSTONE_RETENTION_DAYS`). Devices offline longer than this window require a deliberate backup/full-recovery procedure; the client must not silently discard local data.
- [x] Document dependency/security checks in the release checklist; run `npm audit` after each release (current audit result must be recorded per deployment).
- [x] Add a server Vitest route/regression foundation; full PostgreSQL-backed coverage remains tracked in the P0 audit below.

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

## Future-proof hardening audit (2026-08-03)

This section records the follow-up security and operational audit. Items remain
unchecked until the corresponding implementation and validation are complete.
The focused P0 regression tests are not a substitute for full PostgreSQL-backed
route integration tests; that broader work remains explicitly tracked below.
The priorities assume the current single-user VPS deployment; distributed or
multi-user requirements are called out separately rather than treated as
immediate vulnerabilities.

### P0 — protect the production boundary

- [x] Remove the public `POST /api/auth/setup` endpoint; fresh installs now create the first account through the server-side CLI seed flow. Evidence: `apps/server/src/routes/auth.ts`, `apps/server/src/seed.ts`, `scripts/setup.sh`, and P0 regression tests.
- [x] Bind the production backend to loopback (`127.0.0.1`) so the Node port is not a public bypass of Caddy.
- [x] Stop trusting the spoofable first `X-Forwarded-For` value in rate limiting. The limiter now prefers proxy-controlled `X-Real-IP` and falls back to the final forwarded hop; the backend also binds to loopback by default and regression coverage is in the P0 test.
- [ ] Add a backend integration-test suite covering auth, session expiry, rate limits, route authorization, note conflicts, sync cursors, uploads, and backup validation. The current P0 suite is a focused regression foundation, not full route/database coverage.

### P1 — data, upload, and recovery safety

- [x] Remove SVG uploads and validate the declared upload MIME, UUID, filename, and size server-side; backup attachments use the same MIME allowlist. Binary magic-byte verification and legacy-object reconciliation remain follow-up work.
- [x] Bind presigned PUT requests to the expected `Content-Type`, then verify object MIME and size at completion; this does not replace binary-content sniffing.
- [ ] Introduce shared Zod schemas for auth, note, tag, search, sync, upload, and backup inputs beyond the upload boundary.
- [ ] Audit every resource route for explicit ownership checks using the authenticated user context, preserving the pattern needed for future multi-user support.
- [ ] Add attachment-object disaster recovery: reconcile database metadata with R2 objects, detect orphans/missing objects, and define a second-copy or restore policy.
- [ ] Run an automated restore drill against a temporary PostgreSQL database and representative R2 objects; record measured RPO/RTO.
- [ ] Align backup retention with tombstone retention, or document and test the recovery behavior when a restored backup is older than the tombstone window.
- [ ] Document the encryption boundary accurately: current server-side content encryption still derives a searchable `tsvector` from plaintext, so it is not end-to-end encryption.
- [ ] Add `/readyz` with a database readiness check while keeping `/healthz` as a lightweight process liveness check.
- [ ] Configure production database least privilege, connection timeouts, and TLS when PostgreSQL is not strictly local.

### P1/P2 — deployment and operations

- [ ] Add a global deploy lock to prevent concurrent release, migration, rollback, or service-restart operations.
- [ ] Add deployment preflight checks for placeholder secrets, HTTPS origin, R2 configuration, Caddy validation, disk space, database connectivity, and frontend artifacts.
- [ ] Add security-focused audit events for failed login, setup attempts, rate-limit responses, invalid sessions, upload mismatch, rejected imports, and recovery-required sync states without logging secrets or note content.
- [ ] Add alerts for service failure/restart loops, failed or missing backups, low disk space, and R2 reconciliation failures.
- [ ] Add cleanup jobs for expired sessions, failed queue records, orphan attachments, orphan R2 objects, old deployment snapshots, and bounded journal/log retention.

### P2 — scale and supply-chain readiness

- [ ] Add Playwright browser smoke tests for login, search typing (`a → ab → abc`), saved views, sorting, mobile sidebar, editing, upload, offline queue, and refresh recovery.
- [ ] Enforce CI checks with `npm ci`, lockfile integrity, high/critical vulnerability scanning, frontend/backend tests, typechecks, builds, shell syntax checks, and server integration tests.
- [ ] Generate an SBOM and establish dependency update/CVE monitoring.
- [ ] Add scale fixtures and benchmarks for 1,000, 10,000, and 50,000 notes, including search, backlinks, tree rendering, and IndexedDB memory behavior.
- [ ] Add quotas for note count, content size, attachment count, and total attachment storage before multi-user or public deployment.

### Explicit architectural decisions to revisit

- [ ] Decide whether server-side full-text search is acceptable or whether content search must become client-side for a stronger E2EE model.
- [ ] Add master-key rotation and re-encryption tooling before treating encrypted backups as a long-term key-management solution.
- [ ] Define the migration path to distributed rate limiting and queue leases before running multiple backend instances.

## Hardening tracking TODO list

Update this list as work is completed. For every checked item, record the
commit, tests, and deployment/restore evidence in the release checklist above.

- [x] **HARD-001** — Protect initial setup endpoint by making initial account creation CLI-only; evidence is recorded in the P0 auth test and release checklist.
- [x] **HARD-002** — Fix trusted proxy/IP handling for rate limiting; prefer proxy-controlled `X-Real-IP` and use the final forwarded hop only as fallback, with regression tests. Node now binds to loopback by default.
- [ ] **HARD-003** — Expand the backend P0 regression foundation into full PostgreSQL-backed route/database integration tests; listener-free app request coverage is now present.
- [x] **HARD-004** — Harden declared SVG/MIME and presigned upload validation; evidence: `apps/server/src/lib/upload-validation.ts`, upload/backup routes, R2 signed `Content-Type`, and upload regression tests. Binary magic-byte verification remains a follow-up.
- [ ] **HARD-005** — Add shared request schemas and resource ownership checks; upload schema coverage is partial and broader route validation remains.
- [ ] **HARD-006** — Add attachment reconciliation and disaster-recovery policy.
- [ ] **HARD-007** — Automate database/R2 restore drills and record RPO/RTO.
- [ ] **HARD-008** — Add `/readyz`, database timeouts, TLS/least privilege review.
- [ ] **HARD-009** — Add deploy lock and production preflight validation.
- [ ] **HARD-010** — Add security audit events, alerts, and cleanup jobs.
- [ ] **HARD-011** — Add Playwright browser smoke coverage.
- [ ] **HARD-012** — Enforce CI, vulnerability scanning, SBOM, and dependency monitoring.
- [ ] **HARD-013** — Add scale fixtures, quotas, and benchmark evidence.
- [ ] **HARD-014** — Decide and document the server-side search versus E2EE boundary.
- [ ] **HARD-015** — Design key rotation and multi-instance readiness.

_Last audited: 2026-08-03. Checked items include implementation and automated validation evidence; remaining items are not complete solely because they are documented._
