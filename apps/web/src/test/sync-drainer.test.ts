import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type PendingMutation } from '../db/db';

const pushMocks = vi.hoisted(() => ({
  pushMutation: vi.fn(),
}));

vi.mock('../api/client', () => ({
  shouldSync: () => true,
}));

vi.mock('../sync/push', () => ({
  pushMutation: pushMocks.pushMutation,
  isExhausted: (mutation: PendingMutation) => mutation.attempts >= 10,
}));

import { drainQueue } from '../sync/drainer';

function makeMutation(id: string, createdAt: number): PendingMutation {
  return {
    id,
    type: 'patch_note',
    resourceId: `note-${id}`,
    payload: JSON.stringify({ title: id }),
    baseVersion: 1,
    createdAt,
    attempts: 0,
    lastError: null,
    status: 'pending',
  };
}

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

beforeEach(async () => {
  await db.pendingMutations.clear();
  await db.syncState.clear();
  pushMocks.pushMutation.mockReset();
  setOnline(true);
});

describe('sync drainer connectivity guardrails', () => {
  it('does not spend mutation attempts while the browser is offline', async () => {
    await db.pendingMutations.add(makeMutation('offline', 1));
    setOnline(false);

    await drainQueue();

    expect(pushMocks.pushMutation).not.toHaveBeenCalled();
    expect(await db.pendingMutations.get('offline')).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('stops FIFO draining after a retryable failure', async () => {
    await db.pendingMutations.bulkAdd([
      makeMutation('first', 1),
      makeMutation('second', 2),
    ]);
    pushMocks.pushMutation.mockResolvedValue({
      status: 'failed',
      error: 'Failed to fetch',
      retryable: true,
    });

    await drainQueue();

    expect(pushMocks.pushMutation).toHaveBeenCalledTimes(1);
    expect(await db.pendingMutations.get('first')).toMatchObject({
      status: 'failed',
      lastError: 'Failed to fetch',
    });
    expect(await db.pendingMutations.get('second')).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });
});
