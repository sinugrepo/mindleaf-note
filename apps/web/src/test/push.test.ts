import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type PendingMutation } from '../db/db';
import type { Note } from '../types';

const mocks = vi.hoisted(() => ({
  deleteNote: vi.fn(),
  restoreNote: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: {
    deleteNote: mocks.deleteNote,
    restoreNote: mocks.restoreNote,
  },
}));

import { pushMutation } from '../sync/push';

function makeNote(id: string, deletedAt: number | null = null): Note {
  return {
    id,
    parentId: null,
    title: id,
    content: '',
    order: 0,
    isExpanded: true,
    createdAt: 0,
    updatedAt: 0,
    deletedAt,
    dirty: true,
    version: 1,
  };
}

function makeMutation(
  type: 'delete_note' | 'restore_note',
  resourceId: string,
  descendantIds: string[] = [],
): PendingMutation {
  return {
    id: `${type}-${resourceId}`,
    type,
    resourceId,
    payload: JSON.stringify({ descendantIds }),
    baseVersion: null,
    createdAt: 1,
    attempts: 0,
    lastError: null,
    status: 'pending',
  };
}

beforeEach(async () => {
  await db.notes.clear();
  await db.pendingMutations.clear();
  mocks.deleteNote.mockReset();
  mocks.restoreNote.mockReset();
});

describe('pushMutation stale trash operations', () => {
  it('settles a delete mutation when the server returns 404', async () => {
    await db.notes.bulkAdd([
      makeNote('root', Date.now()),
      makeNote('child', Date.now()),
    ]);
    const mutation = makeMutation('delete_note', 'root', ['child']);
    await db.pendingMutations.add(mutation);
    mocks.deleteNote.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));

    await expect(pushMutation(mutation)).resolves.toEqual({ status: 'ok' });

    expect(mocks.deleteNote).toHaveBeenCalledWith('root');
    expect((await db.notes.get('root'))?.dirty).toBe(false);
    expect((await db.notes.get('child'))?.dirty).toBe(false);
  });

  it('settles a restore mutation when the server returns 404', async () => {
    await db.notes.bulkAdd([
      makeNote('root', Date.now()),
      makeNote('child', Date.now()),
    ]);
    const mutation = makeMutation('restore_note', 'root', ['child']);
    await db.pendingMutations.add(mutation);
    mocks.restoreNote.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));

    await expect(pushMutation(mutation)).resolves.toEqual({ status: 'ok' });

    expect(mocks.restoreNote).toHaveBeenCalledWith('root');
    expect((await db.notes.get('root'))?.dirty).toBe(false);
    expect((await db.notes.get('child'))?.dirty).toBe(false);
  });
});
