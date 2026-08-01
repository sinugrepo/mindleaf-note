import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw, X } from 'lucide-react';
import { useSyncStatus } from '../sync/useSyncStatus';
import { retryFailedMutations } from '../sync/retry';
import { db } from '../db/db';
import { api } from '../api/client';
import { resolveKeepMine, resolveKeepBoth, resolveUseRemote } from '../sync/conflict';
import { useLiveQuery } from 'dexie-react-hooks';
import { cn } from '../lib/utils';

export function SyncStatus() {
  const info = useSyncStatus();
  const [open, setOpen] = useState(false);
  const Icon = info.status === 'synced' ? CheckCircle2 : info.status === 'offline' ? CloudOff : info.status === 'conflicted' ? AlertTriangle : Loader2;
  const label = info.status === 'synced' ? 'Synced' : info.status === 'offline' ? `Offline · ${info.pendingCount} pending` : info.status === 'conflicted' ? `${info.conflictedCount} conflict${info.conflictedCount === 1 ? '' : 's'}` : `${info.pendingCount} syncing`;
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-label={`Sync status: ${label}`} title={label} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-mono transition-colors hover:bg-zinc-200/70 dark:hover:bg-zinc-800/70', info.status === 'conflicted' ? 'text-amber-600 dark:text-amber-400' : info.status === 'offline' ? 'text-zinc-500' : 'text-zinc-500 dark:text-zinc-400')}><Icon className={cn('w-3.5 h-3.5', info.status === 'pending' && 'animate-spin')} /><span className="hidden sm:inline">{label}</span></button>
    {open && <SyncPanel info={info} onClose={() => setOpen(false)} />}
  </>;
}

function SyncPanel({ info, onClose }: { info: ReturnType<typeof useSyncStatus>; onClose: () => void }) {
  const conflicts = useLiveQuery(() => db.pendingMutations.where('status').equals('conflicted').toArray(), [], []);
  const failures = useLiveQuery(() => db.pendingMutations.where('status').equals('failed').toArray(), [], []);
  const [busy, setBusy] = useState(false);
  const retry = async () => { setBusy(true); try { await retryFailedMutations(); } finally { setBusy(false); } };
  return <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/20 dark:bg-black/50 backdrop-blur-sm" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-labelledby="sync-panel-title" className="w-[min(92vw,520px)] max-h-[80vh] overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-center justify-between"><h2 id="sync-panel-title" className="font-semibold dark:text-zinc-100">Sync status</h2><button type="button" onClick={onClose} aria-label="Close sync status"><X className="w-4 h-4" /></button></div>
      <p className="mt-2 text-sm text-zinc-500">{info.status === 'offline' ? 'Changes are safe locally and will sync when you reconnect.' : info.status === 'synced' ? 'All local changes are synced.' : 'Some local changes still need attention.'}</p>
      {(failures?.length ?? 0) > 0 && <section className="mt-4"><h3 className="text-xs font-semibold uppercase text-red-500">Failed ({failures?.length})</h3><div className="mt-1 space-y-1">{failures?.map((mutation) => <p key={mutation.id} className="text-xs text-zinc-500 truncate" title={mutation.lastError ?? ''}>{mutation.resourceId}: {mutation.lastError || 'Request failed'}</p>)}</div><button type="button" onClick={() => void retry()} disabled={busy} className="mt-3 inline-flex items-center gap-1 rounded bg-blue-500 px-3 py-1.5 text-xs text-white disabled:opacity-50"><RefreshCw className={cn('w-3 h-3', busy && 'animate-spin')} /> Retry failed</button></section>}
      {(conflicts?.length ?? 0) > 0 && <section className="mt-5"><h3 className="text-xs font-semibold uppercase text-amber-600">Conflicts ({conflicts?.length})</h3><div className="mt-2 space-y-3">{conflicts?.map((mutation) => <ConflictRow key={mutation.id} mutation={mutation} />)}</div></section>}
    </div>
  </div>;
}

function ConflictRow({ mutation }: { mutation: import('../db/db').PendingMutation }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (choice: 'remote' | 'mine' | 'both') => {
    setBusy(true);
    setError(null);
    try {
      const remote = await api.getNote(mutation.resourceId);
      const local = await db.notes.get(mutation.resourceId);
      if (!local) throw new Error('Local note is no longer available');
      if (choice === 'remote') await resolveUseRemote(mutation.id, remote);
      else if (choice === 'mine') await resolveKeepMine(mutation.id, remote.version);
      else await resolveKeepBoth(mutation.id, local, remote);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : 'Conflict resolution failed');
    } finally { setBusy(false); }
  };
  return <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 p-3"><p className="text-xs text-zinc-600 dark:text-zinc-300 truncate">Note {mutation.resourceId}</p>{error && <p role="alert" className="mt-2 text-[11px] text-red-600 dark:text-red-400">{error}</p>}<div className="mt-2 flex flex-wrap gap-1.5"><button disabled={busy} onClick={() => void resolve('remote')} className="rounded bg-zinc-100 dark:bg-zinc-800 px-2 py-1 text-[11px]">Use remote</button><button disabled={busy} onClick={() => void resolve('mine')} className="rounded bg-amber-500 px-2 py-1 text-[11px] text-white">Keep mine</button><button disabled={busy} onClick={() => void resolve('both')} className="rounded bg-blue-500 px-2 py-1 text-[11px] text-white">Keep both</button></div></div>;
}
