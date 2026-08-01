import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useState, useEffect } from 'react';

export type SyncStatus = 'synced' | 'pending' | 'offline' | 'conflicted' | 'remote_missing' | 'remote_recovering';

export interface SyncStatusInfo {
  status: SyncStatus;
  pendingCount: number;
  conflictedCount: number;
  remoteMissingCount: number;
  remoteRecoveringCount: number;
  failedCount: number;
  isOnline: boolean;
}

/**
 * Hook for the sync status indicator (traffic-light icon in the header).
 *
 * Uses `useLiveQuery` on `pendingMutations` so the indicator auto-updates
 * when mutations are enqueued, drained, or marked conflicted.
 *
 * Status logic:
 *   - `offline`: navigator.onLine is false. Sub-status shows pending count.
 *   - `conflicted`: at least one mutation is in `conflicted` status.
 *   - `pending`: at least one mutation is in `pending` or `failed` status.
 *   - `synced`: no pending mutations and online.
 */
export function useSyncStatus(): SyncStatusInfo {
  const pendingCount = useLiveQuery(
    () =>
      db.pendingMutations
        .where('status')
        .anyOf(['pending', 'in_progress', 'failed'])
        .count(),
    [],
    0,
  );

  const conflictedCount = useLiveQuery(
    () => db.pendingMutations.where('status').equals('conflicted').count(),
    [],
    0,
  );

  const remoteMissingCount = useLiveQuery(
    async () => (await db.pendingMutations.where('status').equals('remote_missing').toArray())
      .filter((mutation) => mutation.type === 'patch_note').length,
    [],
    0,
  );

  const remoteRecoveringCount = useLiveQuery(
    async () => (await db.pendingMutations.where('status').equals('remote_recovering').toArray())
      .filter((mutation) => mutation.type === 'patch_note').length,
    [],
    0,
  );

  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const pc = pendingCount ?? 0;
  const cc = conflictedCount ?? 0;
  const rmc = remoteMissingCount ?? 0;
  const rrc = remoteRecoveringCount ?? 0;
  const fc = pc; // failed + pending are both in the 'pending'/'failed' bucket

  let status: SyncStatus;
  if (!isOnline) {
    status = 'offline';
  } else if (cc > 0) {
    status = 'conflicted';
  } else if (rrc > 0) {
    status = 'remote_recovering';
  } else if (rmc > 0) {
    status = 'remote_missing';
  } else if (pc > 0) {
    status = 'pending';
  } else {
    status = 'synced';
  }

  return {
    status,
    pendingCount: pc,
    conflictedCount: cc,
    remoteMissingCount: rmc,
    remoteRecoveringCount: rrc,
    failedCount: fc,
    isOnline,
  };
}
