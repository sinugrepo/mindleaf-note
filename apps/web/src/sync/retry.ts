import { db } from '../db/db';
import { drainQueue } from './drainer';

export async function retryFailedMutations(): Promise<number> {
  const failed = await db.pendingMutations.where('status').equals('failed').toArray();
  if (failed.length === 0) return 0;
  await db.pendingMutations.bulkUpdate(failed.map((mutation) => ({
    key: mutation.id,
    changes: { status: 'pending' as const, attempts: 0, lastError: null },
  })));
  await drainQueue();
  return failed.length;
}
