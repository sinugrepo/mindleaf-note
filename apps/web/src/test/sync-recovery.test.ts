import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetStaleRemoteRecoveries, type PendingMutation } from '../db/db';
import { discardAllSyncHistory, discardSyncMutation } from '../sync/retry';

function makeNote(id: string) {
  return {
    id,
    parentId: null,
    title: 'Local',
    content: '<p>local</p>',
    order: 1,
    isExpanded: true,
    createdAt: 1,
    updatedAt: 2,
    version: 2,
    dirty: true,
  };
}

function makeMutation(
  id: string,
  type: PendingMutation['type'],
  resourceId: string,
  status: PendingMutation['status'],
): PendingMutation {
  return {
    id,
    type,
    resourceId,
    payload: '{}',
    baseVersion: null,
    createdAt: 1,
    attempts: 0,
    lastError: 'Remote note no longer exists (404)',
    status,
  };
}

beforeEach(async () => {
  await db.notes.clear();
  await db.attachments.clear();
  await db.pendingMutations.clear();
});

describe('sync recovery lifecycle', () => {
  it('does not treat a remote-missing attachment as a note when clearing history', async () => {
    await db.notes.add(makeNote('note-1'));
    await db.attachments.add({
      id: 'attachment-1',
      noteId: 'note-1',
      blob: new Blob(['image'], { type: 'image/png' }),
      mime: 'image/png',
      name: 'image.png',
      createdAt: 1,
      syncStatus: 'local_only',
    });
    await db.pendingMutations.add(
      makeMutation('upload-1', 'upload_attachment', 'attachment-1', 'remote_missing'),
    );

    expect(await discardSyncMutation('upload-1')).toBe(true);
    expect(await db.notes.get('note-1')).toBeDefined();
    expect(await db.attachments.get('attachment-1')).toMatchObject({ syncStatus: 'local_only' });
    expect(await db.pendingMutations.get('upload-1')).toBeUndefined();
  });

  it('clears a remote-missing note and all related attachment queue records', async () => {
    await db.notes.add(makeNote('note-1'));
    await db.attachments.add({
      id: 'attachment-1',
      noteId: 'note-1',
      blob: new Blob(['image'], { type: 'image/png' }),
      mime: 'image/png',
      name: 'image.png',
      createdAt: 1,
    });
    await db.pendingMutations.bulkAdd([
      makeMutation('patch-1', 'patch_note', 'note-1', 'remote_missing'),
      makeMutation('upload-1', 'upload_attachment', 'attachment-1', 'remote_missing'),
    ]);

    // The note mutation cascades deletion of its related attachment queue
    // record, so the batch operation reports one root record discarded.
    expect(await discardAllSyncHistory()).toBe(1);
    expect(await db.notes.get('note-1')).toBeUndefined();
    expect(await db.attachments.get('attachment-1')).toBeUndefined();
    expect(await db.pendingMutations.count()).toBe(0);
  });

  it('removes stale attachment recovery records when note recreation was queued before a crash', async () => {
    await db.notes.add({ ...makeNote('note-1'), content: '<img src="attachment:attachment-1">' });
    await db.attachments.add({
      id: 'attachment-1',
      noteId: 'note-1',
      blob: new Blob(['image'], { type: 'image/png' }),
      mime: 'image/png',
      name: 'image.png',
      createdAt: 1,
      syncStatus: 'local_only',
    });
    await db.pendingMutations.bulkAdd([
      makeMutation('old-note', 'patch_note', 'note-1', 'remote_recovering'),
      makeMutation('old-upload', 'upload_attachment', 'attachment-1', 'remote_missing'),
      makeMutation('new-note', 'create_note', 'note-1', 'pending'),
      makeMutation('new-upload', 'upload_attachment', 'attachment-1', 'pending'),
    ]);

    expect(await resetStaleRemoteRecoveries()).toBe(1);
    expect(await db.pendingMutations.get('old-note')).toBeUndefined();
    expect(await db.pendingMutations.get('old-upload')).toBeUndefined();
    expect(await db.pendingMutations.get('new-note')).toBeDefined();
    expect(await db.pendingMutations.get('new-upload')).toBeDefined();
  });
});
