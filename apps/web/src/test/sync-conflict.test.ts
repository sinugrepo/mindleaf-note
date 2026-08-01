import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type PendingMutation } from '../db/db';
import {
  resolveKeepMine,
  resolveUseRemote,
  resolveRemoteMissingKeepMine,
  resolveRemoteMissingDeleteLocal,
} from '../sync/conflict';

const queueMocks = vi.hoisted(() => ({
  notifyDrainer: vi.fn(),
  queuedImportNotes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../sync/queue', () => queueMocks);

function makeNote(id: string, overrides: Partial<{ version: number; title: string }> = {}) {
  return {
    id,
    parentId: null,
    title: overrides.title ?? 'Local',
    content: '<p>local</p>',
    order: 1,
    isExpanded: true,
    createdAt: 1,
    updatedAt: 2,
    version: overrides.version ?? 2,
    dirty: true,
  };
}

function makeMutation(id: string, resourceId: string, status: PendingMutation['status'] = 'conflicted'): PendingMutation {
  return {
    id,
    type: 'patch_note',
    resourceId,
    payload: JSON.stringify({ title: 'Local' }),
    baseVersion: 1,
    createdAt: 1,
    attempts: 1,
    lastError: 'Conflict',
    status,
  };
}

const remote = {
  id: 'note-1',
  parentId: null,
  title: 'Remote',
  content: '<p>remote</p>',
  isFolder: false,
  isExpanded: false,
  orderIdx: 9,
  tags: ['remote'],
  deletedAt: null,
  createdAt: 1,
  updatedAt: 3,
  version: 7,
};

beforeEach(async () => {
  await db.notes.clear();
  await db.attachments.clear();
  await db.pendingMutations.clear();
});

describe('sync conflict resolution', () => {
  it('Use Remote replaces a missing/stale local row and clears all queued mutations', async () => {
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
      makeMutation('conflict-1', 'note-1'),
      makeMutation('later-1', 'note-1', 'pending'),
      { ...makeMutation('upload-1', 'attachment-1', 'failed'), type: 'upload_attachment' },
    ]);

    await resolveUseRemote('conflict-1', remote);

    expect(await db.notes.get('note-1')).toMatchObject({
      title: 'Remote',
      content: '<p>remote</p>',
      order: 9,
      version: 7,
      dirty: false,
    });
    expect(await db.pendingMutations.where('resourceId').equals('note-1').count()).toBe(0);
    expect(await db.pendingMutations.where('resourceId').equals('attachment-1').count()).toBe(0);
  });

  it('recreates a local note when the remote note is already gone', async () => {
    await db.notes.add(makeNote('note-1'));
    await db.pendingMutations.add(makeMutation('conflict-1', 'note-1', 'remote_missing'));

    await resolveRemoteMissingKeepMine('conflict-1', makeNote('note-1'));

    expect(await db.pendingMutations.where('resourceId').equals('note-1').count()).toBe(0);
    expect(queueMocks.queuedImportNotes).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'note-1', version: 1, dirty: true })],
      [],
    );
  });

  it('recreates local attachments and removes their stale upload mutations', async () => {
    const attachment = {
      id: 'attachment-1',
      noteId: 'note-1',
      blob: new Blob(['image'], { type: 'image/png' }),
      mime: 'image/png',
      name: 'image.png',
      createdAt: 1,
      r2Key: 'old-key',
      syncStatus: 'synced' as const,
    };
    const localNote = { ...makeNote('note-1'), content: '<img src="attachment:attachment-1">' };
    await db.notes.add(localNote);
    await db.attachments.add(attachment);
    await db.pendingMutations.bulkAdd([
      makeMutation('conflict-1', 'note-1', 'remote_missing'),
      { ...makeMutation('upload-1', 'attachment-1', 'failed'), type: 'upload_attachment' },
    ]);

    await resolveRemoteMissingKeepMine('conflict-1', localNote);

    expect(queueMocks.queuedImportNotes).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'note-1' })],
      [expect.objectContaining({ id: 'attachment-1', r2Key: null, syncStatus: 'local_only' })],
    );
    expect(await db.pendingMutations.where('resourceId').equals('note-1').count()).toBe(0);
    expect(await db.pendingMutations.where('resourceId').equals('attachment-1').count()).toBe(0);
  });

  it('deletes the local note and queue when choosing delete after a remote 404', async () => {
    await db.notes.add(makeNote('note-1'));
    const attachment = {
      id: 'attachment-1',
      noteId: 'note-1',
      blob: new Blob(['image'], { type: 'image/png' }),
      mime: 'image/png',
      name: 'image.png',
      createdAt: 1,
    };
    await db.attachments.add(attachment);
    await db.pendingMutations.bulkAdd([
      makeMutation('conflict-1', 'note-1', 'remote_missing'),
      { ...makeMutation('upload-1', 'attachment-1', 'failed'), type: 'upload_attachment' },
    ]);

    await resolveRemoteMissingDeleteLocal('conflict-1', 'note-1');

    expect(await db.notes.get('note-1')).toBeUndefined();
    expect(await db.attachments.get('attachment-1')).toBeUndefined();
    expect(await db.pendingMutations.where('resourceId').equals('note-1').count()).toBe(0);
    expect(await db.pendingMutations.where('resourceId').equals('attachment-1').count()).toBe(0);
  });

  it('Keep Mine rebases all queued edits onto the remote version', async () => {
    await db.notes.add(makeNote('note-1', { version: 4 }));
    await db.pendingMutations.bulkAdd([
      makeMutation('conflict-1', 'note-1'),
      makeMutation('later-1', 'note-1', 'pending'),
    ]);

    await resolveKeepMine('conflict-1', 7);

    const note = await db.notes.get('note-1');
    const queued = await db.pendingMutations.where('resourceId').equals('note-1').toArray();
    expect(note).toMatchObject({ version: 7, dirty: true });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: 'patch_note', baseVersion: 7, status: 'pending' });
    expect(JSON.parse(queued[0].payload)).toMatchObject({ title: 'Local', content: '<p>local</p>' });
  });
});
