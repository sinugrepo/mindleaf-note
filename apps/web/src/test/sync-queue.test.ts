import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { queuedCreateNote, queuedPatchNote } from '../sync/queue';
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

  it('folds an offline rename into the pending create instead of queuing a PATCH', async () => {
    const folder = {
      id: 'folder-1',
      parentId: null,
      title: 'New folder',
      content: '',
      order: 1,
      isExpanded: true,
      isFolder: true,
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      dirty: true,
    };
    await queuedCreateNote(folder);
    await queuedPatchNote(folder.id, { title: 'Renamed folder' }, 100);

    const queued = await db.pendingMutations.where('resourceId').equals(folder.id).toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: 'create_note', status: 'pending', attempts: 0 });
    expect(JSON.parse(queued[0].payload)).toMatchObject({
      title: 'Renamed folder',
      isFolder: true,
    });
  });

  it('reactivates a failed patch when a later edit supersedes it', async () => {
    await db.notes.add({
      id: 'note-failed',
      parentId: null,
      title: 'Original',
      content: '',
      order: 1,
      isExpanded: true,
      createdAt: 1,
      updatedAt: 1,
      version: 3,
      dirty: true,
    });
    await db.pendingMutations.add({
      id: 'failed-patch',
      type: 'patch_note',
      resourceId: 'note-failed',
      payload: JSON.stringify({ title: 'Old attempt' }),
      baseVersion: 2,
      createdAt: 1,
      attempts: 10,
      lastError: 'Failed to fetch',
      status: 'failed',
    });

    await queuedPatchNote('note-failed', { title: 'Latest edit' }, 100);

    const queued = await db.pendingMutations.where('resourceId').equals('note-failed').toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      id: 'failed-patch',
      status: 'pending',
      attempts: 0,
      lastError: null,
    });
    expect(JSON.parse(queued[0].payload)).toEqual({ title: 'Latest edit' });
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
