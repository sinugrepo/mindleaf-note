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

async function drainQueueUnlocked(): Promise<void> {
  if (draining || !shouldSync()) return;
  draining = true;
  try {
    const pending = await db.pendingMutations
      .where('status')
      .anyOf(['pending', 'failed'])
      .sortBy('createdAt');
    for (const mutation of pending) {
      if (mutation.status === 'failed' && isExhausted(mutation)) continue;
      const result = await pushMutation(mutation);
      if (result.status === 'ok') {
        await db.pendingMutations.delete(mutation.id);
      } else if (result.status === 'conflict') {
        await db.pendingMutations.update(mutation.id, {
          status: 'conflicted',
          lastError: 'Conflict — note was updated elsewhere',
        });
      } else {
        await db.pendingMutations.update(mutation.id, {
          status: 'failed',
          lastError: result.error,
        });
      }
    }
  } catch (err) {
    console.error('[sync] drainer error:', err);
  } finally {
    draining = false;
  }
}

export async function drainQueue(): Promise<void> {
  if (draining || !shouldSync()) return;
  try {
    await withSyncLock(drainQueueUnlocked);
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
}

export function notifyDrainer(): void {
  void drainQueue();
}
