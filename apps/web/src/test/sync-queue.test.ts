import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { queuedPatchNote } from '../sync/queue';
import { withSyncLock } from '../sync/coordination';

beforeEach(async () => {
  await db.notes.clear();
  await db.pendingMutations.clear();
  await db.syncState.clear();
});

describe('sync queue stability', () => {
  it('coalesces repeated patches while preserving the first base version', async () => {
    await db.notes.add({
      id: 'note-1',
      parentId: null,
      title: 'Original',
      content: '<p>one</p>',
      order: 1,
      isExpanded: true,
      createdAt: 1,
      updatedAt: 1,
      version: 7,
      dirty: false,
    });

    await queuedPatchNote('note-1', { title: 'Second' }, 100);
    await queuedPatchNote('note-1', { content: '<p>Latest</p>', order: 42 }, 200);

    const queued = await db.pendingMutations.where('resourceId').equals('note-1').toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: 'patch_note',
      baseVersion: 7,
      status: 'pending',
    });
    expect(JSON.parse(queued[0].payload)).toEqual({
      title: 'Second',
      content: '<p>Latest</p>',
      orderIdx: 42,
    });
    expect(await db.notes.get('note-1')).toMatchObject({
      title: 'Second',
      content: '<p>Latest</p>',
      order: 42,
      version: 9,
      dirty: true,
    });
  });

  it('serializes operations through the IndexedDB lease fallback', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withSyncLock(async () => {
      events.push('first:start');
      await firstHeld;
      events.push('first:end');
    });
    const second = withSyncLock(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });
});
