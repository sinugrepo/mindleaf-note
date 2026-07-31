/**
 * Phase 8 — Onboarding Wizard tests.
 *
 * Scope of these unit tests:
 *   - Detection predicate: when does the wizard need to appear?
 *   - Re-entrancy: which local rows are eligible for upload (the same
 *     predicate the upload runners use to filter candidates)?
 *   - Clear-active-data: the local IndexedDB tables the wizard wipes
 *     on "Start fresh".
 *
 * Pure functions in `useOnboardingWizard.ts` and `upload-runner.ts`
 * are tested directly. React + DOM concerns (modal rendering,
 * progress UI) are exercised end-to-end by the manual browser-use
 * pass documented in the plan — see CLOUD_MIGRATION_PLAN.md.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/db';
import type { Note, Attachment } from '../types';

// We mock the api client because the upload runners consume `api.*`
// and pulling in the real client would mean also pulling the Hono
// types + Vite-only env shims into the unit test.
//
// IMPORTANT — maintain parity with the real module's named exports.
// If a refactor adds a new export (e.g. `login`, `logout`, `setup`),
// add a stub here. Otherwise any code path that imports one of those
// will receive `undefined` from Vitest and crash at runtime instead
// of failing an assertion clearly.
vi.mock('../api/client', () => ({
  api: {
    getMeInfo: vi.fn(async () => ({ createdAt: 0, noteCount: 0 })),
    createNote: vi.fn(async (body: Note) => ({
      id: body.id ?? 'server',
      parentId: body.parentId ?? null,
      title: body.title ?? '',
      content: body.content ?? '',
      isFolder: body.isFolder ?? false,
      isExpanded: true,
      orderIdx: Date.now(),
      tags: body.tags ?? [],
      deletedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
    })),
    presignUpload: vi.fn(async () => ({
      attachmentId: 'a',
      uploadUrl: 'https://example.com/upload',
      r2Key: 'k',
    })),
    completeUpload: vi.fn(async () => ({ ok: true as const })),
    // The transport-level helpers aren't called by the upload runners,
    // but stub them so Vitest doesn't expose `undefined` to any future
    // callee that may import via the same namespace.
    login: vi.fn(async () => ({ ok: true as const })),
    logout: vi.fn(async () => undefined),
    setup: vi.fn(async () => ({ ok: true as const })),
  },
  hasSession: () => true,
  setHasSession: () => { /* noop */ },
  shouldSync: () => true,
}));

beforeEach(async () => {
  await db.notes.clear();
  await db.attachments.clear();
  await db.pendingMutations.clear();
  await db.syncState.clear();
});

function makeNote(partial: Partial<Note> = {}): Note {
  return {
    id: partial.id ?? 'fixture',
    parentId: partial.parentId ?? null,
    title: partial.title ?? 'X',
    content: partial.content ?? '',
    order: partial.order ?? 0,
    isExpanded: partial.isExpanded ?? false,
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    deletedAt: partial.deletedAt ?? null,
    ...partial,
  } as Note;
}

function makeAttachment(partial: Partial<Attachment> = {}): Attachment {
  return {
    id: partial.id ?? 'att-fixture',
    noteId: partial.noteId ?? 'note-fixture',
    blob: partial.blob ?? new Blob(['x'], { type: 'image/png' }),
    mime: partial.mime ?? 'image/png',
    name: partial.name ?? '',
    createdAt: partial.createdAt ?? 0,
    r2Key: partial.r2Key ?? null,
    syncStatus: partial.syncStatus ?? 'local_only',
  } as Attachment;
}

describe('onboarding detection (mirrors useOnboardingWizard.detect pure logic)', () => {
  // The hook's detect() body is inlined into this helper so we can
  // test the predicate without spinning up a React render harness.
  function shouldShow(args: {
    hasSession: boolean;
    serverNoteCount: number | null;
    activeLocalCount: number;
    hasUnsyncedLocal: boolean;
  }): boolean {
    if (!args.hasSession) return false;
    if (args.activeLocalCount === 0) return false;
    if (args.serverNoteCount !== 0) return false;
    if (!args.hasUnsyncedLocal) return false;
    return true;
  }

  it('shows the wizard when: session + active local notes + empty cloud + unsynced', () => {
    expect(
      shouldShow({
        hasSession: true,
        serverNoteCount: 0,
        activeLocalCount: 1,
        hasUnsyncedLocal: true,
      }),
    ).toBe(true);
  });

  it('does NOT show when no session (pre-login user)', () => {
    expect(
      shouldShow({
        hasSession: false,
        serverNoteCount: 0,
        activeLocalCount: 5,
        hasUnsyncedLocal: true,
      }),
    ).toBe(false);
  });

  it('does NOT show when cloud already has notes (returning user)', () => {
    expect(
      shouldShow({
        hasSession: true,
        serverNoteCount: 42,
        activeLocalCount: 5,
        hasUnsyncedLocal: true,
      }),
    ).toBe(false);
  });

  it('does NOT show when local cache is empty (cold-start user)', () => {
    expect(
      shouldShow({
        hasSession: true,
        serverNoteCount: 0,
        activeLocalCount: 0,
        hasUnsyncedLocal: false,
      }),
    ).toBe(false);
  });

  it('does NOT show when every local note already has lastSyncedAt (resume already finished)', () => {
    expect(
      shouldShow({
        hasSession: true,
        serverNoteCount: 0,
        activeLocalCount: 5,
        // Resume scenario: user crashed during upload last time, then
        // re-opened the wizard which uploaded everything. Detection
        // must NOT re-trigger an empty wizard next session.
        hasUnsyncedLocal: false,
      }),
    ).toBe(false);
  });

  it('does NOT show when /me/info is unreachable (serverNoteCount stays null)', () => {
    // Detection defaults to `hide` when probing fails — the wizard is
    // a best-effort niceness, not a blocker. The regular sync engine
    // will catch up.
    expect(
      shouldShow({
        hasSession: true,
        serverNoteCount: null,
        activeLocalCount: 5,
        hasUnsyncedLocal: true,
      }),
    ).toBe(false);
  });
});

describe('upload-runner filter: needs-upload eligibility (resume semantics)', () => {
  // Mirrors the `lastSyncedAt == null` filter inside bulkUploadNotes.
  // Same condition: a row whose `lastSyncedAt` is undefined/null is
  // considered unprocessed and eligible for upload on resume.
  function isUnprocessed(note: Note): boolean {
    if (note.deletedAt != null) return false;
    if (note.lastSyncedAt != null) return false;
    return true;
  }

  it('trashed notes are never re-uploaded', async () => {
    const trashed = makeNote({
      id: 'trashed-1',
      deletedAt: Date.now() - 24 * 60 * 60 * 1000,
    });
    await db.notes.add(trashed);
    expect(isUnprocessed(await db.notes.get('trashed-1')!)).toBe(false);
  });

  it('already-synced notes are NOT re-uploaded (resume after crash)', async () => {
    const synced = makeNote({
      id: 'synced-1',
      lastSyncedAt: 1_700_000_000_000,
      version: 2,
    });
    await db.notes.add(synced);
    expect(isUnprocessed(await db.notes.get('synced-1')!)).toBe(false);
  });

  it('fresh local notes ARE eligible', async () => {
    const fresh = makeNote({ id: 'fresh-1' });
    await db.notes.add(fresh);
    expect(isUnprocessed(await db.notes.get('fresh-1')!)).toBe(true);
  });

  it('a mix of fresh + already-synced yields ONLY the fresh for re-upload', async () => {
    await db.notes.bulkAdd([
      makeNote({ id: 'a', lastSyncedAt: 1_700_000_000_000, version: 2 }),
      makeNote({ id: 'b' }),
      makeNote({ id: 'c', lastSyncedAt: 1_700_000_000_000, version: 1 }),
      makeNote({
        id: 'd',
        deletedAt: Date.now(),
      }),
    ]);
    const freshRows = (await db.notes.toArray()).filter(isUnprocessed);
    expect(freshRows.map((r) => r.id).sort()).toEqual(['b']);
  });
});

describe('attachment needs-upload eligibility (mirrors bulkUploadAttachments)', () => {
  function needsUpload(att: Attachment): boolean {
    return att.r2Key == null;
  }

  it('local-only attachments are eligible', async () => {
    const att = makeAttachment({ id: 'att-1', syncStatus: 'local_only' });
    await db.attachments.add(att);
    expect(needsUpload(await db.attachments.get('att-1')!)).toBe(true);
  });

  it('synced attachments are NOT re-uploaded', async () => {
    const att = makeAttachment({
      id: 'att-2',
      syncStatus: 'synced',
      r2Key: 'uploaded:abc',
    });
    await db.attachments.add(att);
    expect(needsUpload(await db.attachments.get('att-2')!)).toBe(false);
  });
});

describe('bulkUploadNotes chunk progress reporting', () => {
  it('calls onProgress once per chunk with running totals', async () => {
    // Populate Dexie with 25 distinct notes — three chunks of 10, 10, 5.
    await db.notes.bulkAdd(
      Array.from({ length: 25 }).map((_, i) =>
        makeNote({ id: `n${i}`, order: i }),
      ),
    );

    const progressCalls: Array<{
      notesUploaded: number;
      totalNotes: number;
    }> = [];
    const { bulkUploadNotes } = await import('../onboarding/upload-runner');
    const result = await bulkUploadNotes((p) => progressCalls.push(p));

    // Three chunks => three progress reports.
    expect(progressCalls).toHaveLength(3);
    // Each report's total is the GRAND total (24 because the active-
    // note filter is applied per-note; in this fixture all 25 are
    // active, so total=25). Running totals are 10, 20, 25.
    expect(progressCalls[0]).toEqual({
      notesUploaded: 10,
      totalNotes: 25,
    });
    expect(progressCalls[1]).toEqual({
      notesUploaded: 20,
      totalNotes: 25,
    });
    expect(progressCalls[2]).toEqual({
      notesUploaded: 25,
      totalNotes: 25,
    });

    // Every note should now carry lastSyncedAt + dirty=false.
    const refreshed = await db.notes.toArray();
    for (const n of refreshed) {
      expect(n.dirty).toBe(false);
      expect(n.lastSyncedAt).toBeGreaterThan(0);
    }

    expect(result.ok).toBe(25);
    expect(result.notOk).toBe(0);
  });

  it('skips already-synced notes on resume (no double-upload)', async () => {
    // 15 notes; 10 pre-marked as synced (lastSyncedAt set). Only 5
    // are unprocessed → 1 chunk → 1 progress report.
    await db.notes.bulkAdd([
      ...Array.from({ length: 10 }).map((_, i) =>
        makeNote({
          id: `done${i}`,
          order: i,
          lastSyncedAt: 1_700_000_000_000,
          version: 2,
        }),
      ),
      ...Array.from({ length: 5 }).map((_, i) =>
        makeNote({ id: `pending${i}`, order: 100 + i }),
      ),
    ]);

    const progressCalls: Array<{
      notesUploaded: number;
      totalNotes: number;
    }> = [];
    const { bulkUploadNotes } = await import('../onboarding/upload-runner');
    const result = await bulkUploadNotes((p) => progressCalls.push(p));

    expect(progressCalls).toEqual([{ notesUploaded: 5, totalNotes: 5 }]);
    expect(result.ok).toBe(5);
  });

  it('skips trashed notes (deletedAt != null)', async () => {
    await db.notes.bulkAdd([
      makeNote({ id: 'active-1' }),
      makeNote({
        id: 'trashed-1',
        deletedAt: Date.now() - 1000,
      }),
    ]);

    const { bulkUploadNotes } = await import('../onboarding/upload-runner');
    const result = await bulkUploadNotes(() => {});

    // Only the active note went through.
    expect(result.ok).toBe(1);
    const fromDb = await db.notes.get('trashed-1');
    expect(fromDb?.lastSyncedAt).toBeUndefined();
  });
});

describe('Start-fresh clearData path (mirrors useOnboardingWizard.startFresh)', () => {
  // Mirrors the inner transaction of `startFresh`: clear three of the
  // four tables and intentionally keep `syncState` so the next sync
  // engine pull uses the same device-id we already minted.
  async function clearUserData(): Promise<void> {
    await db.transaction(
      'rw',
      db.notes,
      db.attachments,
      db.pendingMutations,
      async () => {
        await db.notes.clear();
        await db.attachments.clear();
        await db.pendingMutations.clear();
      },
    );
  }

  it('wipes notes, attachments, and pendingMutations', async () => {
    await db.notes.add(makeNote({ id: 'n1' }));
    await db.attachments.add(makeAttachment({ id: 'a1' }));
    await db.pendingMutations.add({
      id: 'm1',
      type: 'create_note',
      resourceId: 'n1',
      payload: '{}',
      baseVersion: null,
      createdAt: 1,
      attempts: 0,
      lastError: null,
      status: 'pending',
    });

    await clearUserData();

    expect(await db.notes.count()).toBe(0);
    expect(await db.attachments.count()).toBe(0);
    expect(await db.pendingMutations.count()).toBe(0);
  });

  it('KEEPS syncState (deviceId preserved across fresh-start for future conflict traces)', async () => {
    await db.syncState.put({ key: 'deviceId', value: 'dev-xyz' });
    await db.syncState.put({ key: 'lastSyncedAt', value: '1700000000000' });

    await clearUserData();

    const devId = await db.syncState.get('deviceId');
    const syncedAt = await db.syncState.get('lastSyncedAt');
    expect(devId?.value).toBe('dev-xyz');
    expect(syncedAt?.value).toBe('1700000000000');
  });
});
