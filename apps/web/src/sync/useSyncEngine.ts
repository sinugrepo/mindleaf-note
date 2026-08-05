import { useEffect, useRef } from 'react';
import { startDrainer, stopDrainer, notifyDrainer } from './drainer';
import { pullDelta } from './pull';
import { shouldSync, getSyncState, setSyncState } from './queue';
import { resetStaleRemoteRecoveries } from '../db/db';
import { v4 as uuidv4 } from 'uuid';

const PULL_INTERVAL_MS = 60_000; // 60 seconds
const FOCUS_DEBOUNCE_MS = 5000; // 5 seconds

/**
 * Sync engine hook — mounts the background sync machinery.
 *
 * Should be called exactly once, at the app root (App.tsx).
 *
 * Triggers:
 *   - On mount: start drainer + initial delta pull.
 *   - On window focus: delta pull (debounced 5s).
 *   - On `navigator.onLine` → true: drain queue + delta pull.
 *   - Periodic: delta pull every 60 seconds.
 *   - On new mutation: immediate drain (via Dexie 'creating' event).
 *
 * When no session exists (user not logged in), the hook is a no-op —
 * the app runs in pure local mode. Mutations are still enqueued by
 * the queue layer so they can be pushed after login.
 */
export function useSyncEngine(): void {
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pullTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Ensure a deviceId exists for this device.
    (async () => {
      const existing = await getSyncState('deviceId');
      if (!existing) {
        await setSyncState('deviceId', uuidv4());
      }
    })();

    let cancelled = false;
    const startSyncAfterRecoveryReset = async () => {
      // Reset interrupted remote-missing recovery before starting the
      // drainer/pull, so stale quarantine records cannot briefly appear as
      // active sync state or race a new mutation.
      await resetStaleRemoteRecoveries();
      if (cancelled) return;

      // Start the queue worker even if the session is temporarily offline.
      // It self-gates on shouldSync(), and will begin draining as soon as
      // the authenticated shell is mounted again.
      startDrainer();

      // Periodic delta pull (every 60 seconds).
      if (shouldSync()) {
        pullDelta().catch(() => {});
        pullTimerRef.current = setInterval(() => {
          if (shouldSync()) {
            pullDelta().catch(() => {});
          }
        }, PULL_INTERVAL_MS);
      }
    };
    void startSyncAfterRecoveryReset().catch((error) => {
      console.warn('Sync recovery initialization failed:', error);
      if (!cancelled) startDrainer();
    });

    // Window focus → debounced delta pull.
    const handleFocus = () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      focusTimerRef.current = setTimeout(() => {
        if (shouldSync()) {
          pullDelta().catch(() => {});
        }
      }, FOCUS_DEBOUNCE_MS);
    };
    window.addEventListener('focus', handleFocus);

    // Online event → drain + pull.
    const handleOnline = () => {
      notifyDrainer(true);
      if (shouldSync()) {
        pullDelta().catch(() => {});
      }
    };
    window.addEventListener('online', handleOnline);

    return () => {
      cancelled = true;
      stopDrainer();
      if (pullTimerRef.current) clearInterval(pullTimerRef.current);
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleOnline);
    };
  }, []);
}
