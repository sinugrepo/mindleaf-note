import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/db';

const LOCK_NAME = 'mindleaf-sync-drain';
const LEASE_KEY = '__mindleaf_sync_lease__';
const LEASE_TTL_MS = 15_000;
const LEASE_RETRY_MS = 50;
const LEASE_WAIT_MS = 20_000;

interface Lease {
  owner: string;
  expiresAt: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryAcquireLease(owner: string): Promise<boolean> {
  return db.transaction('rw', db.syncState, async () => {
    const existing = await db.syncState.get(LEASE_KEY);
    const now = Date.now();
    let lease: Lease | null = null;
    if (existing) {
      try {
        lease = JSON.parse(existing.value) as Lease;
      } catch {
        lease = null;
      }
    }
    if (lease && lease.owner !== owner && lease.expiresAt > now) return false;
    await db.syncState.put({
      key: LEASE_KEY,
      value: JSON.stringify({ owner, expiresAt: now + LEASE_TTL_MS }),
    });
    return true;
  });
}

async function renewLease(owner: string): Promise<boolean> {
  return db.transaction('rw', db.syncState, async () => {
    const current = await db.syncState.get(LEASE_KEY);
    if (!current) return false;
    try {
      const lease = JSON.parse(current.value) as Lease;
      if (lease.owner !== owner) return false;
      await db.syncState.put({
        key: LEASE_KEY,
        value: JSON.stringify({ owner, expiresAt: Date.now() + LEASE_TTL_MS }),
      });
      return true;
    } catch {
      return false;
    }
  });
}

async function releaseLease(owner: string): Promise<void> {
  await db.transaction('rw', db.syncState, async () => {
    const current = await db.syncState.get(LEASE_KEY);
    if (!current) return;
    try {
      if ((JSON.parse(current.value) as Lease).owner === owner) {
        await db.syncState.delete(LEASE_KEY);
      }
    } catch {
      await db.syncState.delete(LEASE_KEY);
    }
  });
}

/**
 * Run one sync-critical operation at a time across tabs. Modern browsers use
 * Web Locks; older browsers use an expiring IndexedDB lease so a crashed tab
 * cannot hold the queue forever.
 */
export async function withSyncLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) {
    return locks.request(LOCK_NAME, operation);
  }

  const owner = uuidv4();
  const deadline = Date.now() + LEASE_WAIT_MS;
  while (!(await tryAcquireLease(owner))) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the cross-tab sync lock');
    }
    await delay(LEASE_RETRY_MS);
  }
  let lostLease = false;
  const renewTimer = setInterval(() => {
    void renewLease(owner).then((owned) => {
      if (!owned) lostLease = true;
    }).catch(() => {
      // The operation still owns the in-memory execution path; release will
      // clean up if IndexedDB briefly becomes unavailable.
    });
  }, Math.floor(LEASE_TTL_MS / 3));
  try {
    const result = await operation();
    if (lostLease) throw new Error('Cross-tab sync lease expired during operation');
    return result;
  } finally {
    clearInterval(renewTimer);
    await releaseLease(owner);
  }
}
