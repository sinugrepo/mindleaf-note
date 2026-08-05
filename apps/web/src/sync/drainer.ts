/**
 * Sync drainer — processes the IndexedDB mutation queue in FIFO order.
 * A Web Lock prevents two browser tabs from pushing the same mutation at
 * the same time; browsers without Web Locks retain the existing local guard.
 */
import { db, type PendingMutation } from '../db/db';
import { pushMutation, isExhausted } from './push';
import { shouldSync } from '../api/client';
import { withSyncLock } from './coordination';

const DRAIN_INTERVAL_MS = 5000;
let drainTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;
let reconnectRecoveryPending = false;

function isBrowserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function isRetryableMutation(mutation: Pick<PendingMutation, 'retryable' | 'lastError'>): boolean {
  if (mutation.retryable !== undefined) return mutation.retryable;
  const message = mutation.lastError?.toLowerCase() ?? '';
  return message.includes('fetch') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('unavailable') ||
    message.includes('bad gateway') ||
    message.includes('gateway timeout') ||
    /^5\d\d\b/.test(message);
}

async function foldQueuedPatchesIntoCreates(): Promise<void> {
  const creates = await db.pendingMutations
    .where('status')
    .anyOf(['pending', 'failed'])
    .filter((mutation) =>
      mutation.type === 'create_note' &&
      (mutation.status === 'pending' || isRetryableMutation(mutation)),
    )
    .sortBy('createdAt');

  for (const create of creates) {
    const patches = await db.pendingMutations
      .where('resourceId')
      .equals(create.resourceId)
      .filter((mutation) =>
        mutation.type === 'patch_note' &&
        ['pending', 'failed'].includes(mutation.status) &&
        mutation.createdAt >= create.createdAt,
      )
      .sortBy('createdAt');
    if (patches.length === 0) continue;

    let mergedPayload: Record<string, unknown> = {};
    try {
      mergedPayload = JSON.parse(create.payload) as Record<string, unknown>;
    } catch {
      // Keep a valid patch payload even if an old create row was malformed.
    }
    for (const patch of patches) {
      try {
        mergedPayload = { ...mergedPayload, ...JSON.parse(patch.payload) };
      } catch {
        // Ignore malformed legacy rows; the valid create remains recoverable.
      }
    }

    await db.transaction('rw', db.pendingMutations, async () => {
      await db.pendingMutations.update(create.id, {
        payload: JSON.stringify(mergedPayload),
        status: 'pending',
        attempts: 0,
        lastError: null,
        retryable: undefined,
      });
      await db.pendingMutations.bulkDelete(patches.map((patch) => patch.id));
    });
  }
}

async function reactivateExhaustedOfflineFailures(): Promise<void> {
  const failed = await db.pendingMutations
    .where('status')
    .equals('failed')
    .toArray();
  // Legacy clients could exhaust a mutation while offline. Recover only
  // those exhausted connectivity failures once; ordinary retryable failures
  // keep their attempt count so persistent 5xx errors still reach the cap.
  const recoverable = failed.filter((mutation) =>
    isExhausted(mutation) && isRetryableMutation(mutation),
  );
  if (recoverable.length === 0) return;
  await db.pendingMutations.bulkUpdate(recoverable.map((mutation) => ({
    key: mutation.id,
    changes: {
      status: 'pending' as const,
      attempts: 0,
      lastError: null,
      retryable: undefined,
    },
  })));
}

async function drainQueueUnlocked(): Promise<void> {
  // Do not spend retry attempts while the browser is offline. In particular,
  // a create must remain available for a later patch (rename/edit) once the
  // connection returns; otherwise the patch can reach the server first and
  // produce a noisy 404 loop.
  if (draining || !shouldSync() || !isBrowserOnline()) return;
  draining = true;
  try {
    const pending = await db.pendingMutations
      .where('status')
      .anyOf(['pending', 'failed'])
      .sortBy('createdAt');
    for (const mutation of pending) {
      if (
        mutation.status === 'failed' &&
        (isExhausted(mutation) || !isRetryableMutation(mutation))
      ) continue;
      const result = await pushMutation(mutation);
      if (result.status === 'ok') {
        await db.pendingMutations.delete(mutation.id);
      } else if (result.status === 'conflict') {
        await db.pendingMutations.update(mutation.id, {
          status: 'conflicted',
          lastError: 'Conflict — note was updated elsewhere',
          retryable: false,
        });
      } else {
        await db.pendingMutations.update(mutation.id, {
          status: 'failed',
          lastError: result.error,
          retryable: result.retryable,
        });
        // A network/5xx failure blocks the FIFO queue. Stop this drain cycle
        // so dependent mutations (for example a rename after an offline
        // create) cannot overtake the mutation that creates their resource.
        if (result.retryable) break;
      }
    }
  } catch (err) {
    console.error('[sync] drainer error:', err);
  } finally {
    draining = false;
  }
}

export async function drainQueue(): Promise<void> {
  if (draining || !shouldSync() || !isBrowserOnline()) return;
  try {
    await withSyncLock(async () => {
      // Recover exhausted connectivity failures only once for the explicit
      // offline -> online transition. Normal interval ticks must not reset
      // attempts repeatedly, otherwise a persistent outage can bypass the
      // retry cap. A 404/422 remains visible for explicit user recovery.
      if (reconnectRecoveryPending) {
        await reactivateExhaustedOfflineFailures();
        reconnectRecoveryPending = false;
      }
      await foldQueuedPatchesIntoCreates();
      await drainQueueUnlocked();
    });
  } catch (err) {
    // A non-supporting browser may be unable to acquire the fallback lease
    // during a short contention window. The next interval/notification will
    // retry; do not turn this into a visible sync failure.
    console.debug('[sync] drain lock unavailable:', err);
  }
}

export function startDrainer(): void {
  if (drainTimer) return;
  void drainQueue();
  drainTimer = setInterval(() => void drainQueue(), DRAIN_INTERVAL_MS);
}

export function stopDrainer(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
  // Do not carry a reconnect recovery request into a later authenticated
  // session or remounted engine.
  reconnectRecoveryPending = false;
}

export function notifyDrainer(reconnected = false): void {
  if (reconnected) reconnectRecoveryPending = true;
  void drainQueue();
}
