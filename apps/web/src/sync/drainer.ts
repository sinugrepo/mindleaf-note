/**
 * Sync drainer — a background worker that processes the
 * `pending_mutations` queue and pushes each mutation to the backend.
 *
 * Lifecycle:
 *   - Started by the sync engine hook (useSyncEngine) on app mount.
 *   - Runs on a 5-second interval + event-driven (notified by the
 *     queue when a new mutation is enqueued).
 *   - Stops when the component unmounts or the user logs out.
 *
 * Processing order: mutations are processed in `createdAt` order
 * (FIFO) so that a note create is pushed before its subsequent patches.
 *
 * Error handling:
 *   - 200 OK → delete mutation, update note version + clear dirty.
 *   - 409 Conflict → mark `conflicted`, skip (UI will show modal).
 *   - Network error / 5xx → increment attempts, mark `failed`.
 *     Retry on next drain cycle. After MAX_ATTEMPTS, leave as `failed`
 *     for user investigation.
 */

import { db, type PendingMutation } from '../db/db';
import { pushMutation, isExhausted } from './push';
import { shouldSync } from '../api/client';

const DRAIN_INTERVAL_MS = 5000;

let drainTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;

/**
 * Process all pending mutations in order. Called on a timer and
 * on-demand (when a new mutation is enqueued).
 */
export async function drainQueue(): Promise<void> {
  if (draining || !shouldSync()) return;
  draining = true;

  try {
    // Fetch pending mutations in createdAt order.
    const pending = await db.pendingMutations
      .where('status')
      .anyOf(['pending', 'failed'])
      .sortBy('createdAt');

    for (const mutation of pending) {
      // Skip exhausted mutations (they need user intervention).
      if (mutation.status === 'failed' && isExhausted(mutation)) continue;

      const result = await pushMutation(mutation);

      if (result.status === 'ok') {
        await db.pendingMutations.delete(mutation.id);
      } else if (result.status === 'conflict') {
        await db.pendingMutations.update(mutation.id, {
          status: 'conflicted',
          lastError: 'Conflict — note was updated elsewhere',
        });
      } else if (result.status === 'failed') {
        await db.pendingMutations.update(mutation.id, {
          status: 'failed',
          lastError: result.error,
        });
      }
    }
  } catch (err) {
    // Unexpected error in the drainer itself — log and continue.
    // The timer will retry on the next tick.
    console.error('[sync] drainer error:', err);
  } finally {
    draining = false;
  }
}

/**
 * Start the drainer. Called once on app mount by useSyncEngine.
 * Safe to call multiple times — only one timer is active.
 */
export function startDrainer(): void {
  if (drainTimer) return;
  // Immediately attempt a drain (catches mutations enqueued before mount).
  drainQueue().catch(() => {});
  drainTimer = setInterval(() => {
    drainQueue().catch(() => {});
  }, DRAIN_INTERVAL_MS);
}

/**
 * Stop the drainer. Called on unmount or logout.
 */
export function stopDrainer(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
}

/**
 * Notify the drainer that a new mutation was enqueued.
 * Triggers an immediate drain (debounced by the `draining` guard).
 */
export function notifyDrainer(): void {
  drainQueue().catch(() => {});
}
