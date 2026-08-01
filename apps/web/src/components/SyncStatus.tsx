import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw, X } from 'lucide-react';
import { useSyncStatus } from '../sync/useSyncStatus';
import { discardAllSyncHistory, discardSyncMutation, retryFailedMutations } from '../sync/retry';
import { db } from '../db/db';
import { api } from '../api/client';
import {
  resolveKeepMine,
  resolveKeepBoth,
  resolveUseRemote,
  resolveRemoteMissingKeepMine,
  resolveRemoteMissingDeleteLocal,
  markRemoteMissing,
} from '../sync/conflict';
import { useLiveQuery } from 'dexie-react-hooks';
import { cn } from '../lib/utils';

export function SyncStatus() {
  const info = useSyncStatus();
  const [open, setOpen] = useState(false);
  const Icon = info.status === 'synced' ? CheckCircle2 : info.status === 'offline' ? CloudOff : info.status === 'conflicted' || info.status === 'remote_missing' || info.status === 'recovery_required' ? AlertTriangle : Loader2;
  const label = info.status === 'synced' ? 'Synced' : info.status === 'offline' ? `Offline · ${info.pendingCount} pending` : info.status === 'conflicted' ? `${info.conflictedCount} conflict${info.conflictedCount === 1 ? '' : 's'}` : info.status === 'remote_missing' ? 'Remote note missing' : info.status === 'recovery_required' ? 'Recovery required' : info.status === 'remote_recovering' ? 'Recovering note' : `${info.pendingCount} syncing`;
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-label={`Sync status: ${label}`} title={label} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-mono transition-colors hover:bg-zinc-200/70 dark:hover:bg-zinc-800/70',      info.status === 'conflicted' || info.status === 'remote_missing' || info.status === 'recovery_required' ? 'text-amber-600 dark:text-amber-400' : info.status === 'offline' ? 'text-zinc-500' : 'text-zinc-500 dark:text-zinc-400')}><Icon className={cn('w-3.5 h-3.5', info.status === 'pending' && 'animate-spin')} /><span className="hidden sm:inline">{label}</span></button>
    {open && <SyncPanel info={info} onClose={() => setOpen(false)} />}
  </>;
}

function SyncPanel({ info, onClose }: { info: ReturnType<typeof useSyncStatus>; onClose: () => void }) {
  const conflicts = useLiveQuery(() => db.pendingMutations.where('status').equals('conflicted').toArray(), [], []);
  const remoteMissingRecords = useLiveQuery(() => db.pendingMutations.where('status').equals('remote_missing').toArray(), [], []);
  const remoteMissing = (remoteMissingRecords ?? []).filter((mutation) => mutation.type === 'patch_note');
  const failures = useLiveQuery(() => db.pendingMutations.where('status').equals('failed').toArray(), [], []);
  const [busy, setBusy] = useState(false);
  const probedIdsRef = React.useRef(new Set<string>());
  const recovering = useLiveQuery(() => db.pendingMutations.where('status').equals('remote_recovering').toArray(), [], []);
  const hasHistory = (failures?.length ?? 0) + (conflicts?.length ?? 0) + (remoteMissingRecords?.length ?? 0) > 0;
  const recoveryInProgress = (recovering?.length ?? 0) > 0;
  const hasRecoveryRequired = info.recoveryRequired;

  // A 409 conflict can become stale when the remote note is deleted before
  // the user opens this panel. Probe each mutation at most once per mount so
  // the user never has to click an action that can only fail with 404, and
  // avoid overlapping probes when Dexie emits multiple live-query updates.
  useEffect(() => {
    let cancelled = false;
    const probeConflicts = async () => {
      for (const mutation of conflicts ?? []) {
        if (cancelled || probedIdsRef.current.has(mutation.id)) continue;
        probedIdsRef.current.add(mutation.id);
        try {
          await api.getNote(mutation.resourceId);
        } catch (error) {
          if (!cancelled && (error as Error & { status?: number }).status === 404) {
            await markRemoteMissing(mutation.id).catch(() => undefined);
          }
        }
      }
    };
    void probeConflicts();
    return () => { cancelled = true; };
  }, [conflicts]);

  const retry = async () => { setBusy(true); try { await retryFailedMutations(); } finally { setBusy(false); } };
  const discardHistory = async () => {
    if (!hasHistory || busy || recoveryInProgress || !window.confirm('Discard failed, conflicted, and remote-missing sync records? Local changes will stop syncing until edited again.')) return;
    setBusy(true);
    try { await discardAllSyncHistory(); } finally { setBusy(false); }
  };
  return <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/20 dark:bg-black/50 backdrop-blur-sm" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-labelledby="sync-panel-title" className="w-[min(92vw,520px)] max-h-[80vh] overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-center justify-between"><h2 id="sync-panel-title" className="font-semibold dark:text-zinc-100">Sync status</h2><button type="button" onClick={onClose} aria-label="Close sync status"><X className="w-4 h-4" /></button></div>
      <p className="mt-2 text-sm text-zinc-500">{hasRecoveryRequired ? 'This device was offline beyond the server deletion-history window. Do not clear local data automatically; create or verify a backup, then perform an explicit full recovery.' : info.status === 'offline' ? 'Changes are safe locally and will sync when you reconnect.' : info.status === 'synced' ? 'All local changes are synced.' : 'Some local changes still need attention.'}</p>
      {hasRecoveryRequired && <section className="mt-4 rounded-lg border border-amber-200 dark:border-amber-900/60 p-3"><h3 className="text-xs font-semibold uppercase text-amber-600">Full recovery required</h3><p className="mt-1 text-xs text-zinc-500">The server can no longer guarantee deleted items are represented for this old cursor. Preserve a local export before an administrator performs a full snapshot/recovery.</p></section>}
      {(failures?.length ?? 0) > 0 && <section className="mt-4"><h3 className="text-xs font-semibold uppercase text-red-500">Failed ({failures?.length})</h3><div className="mt-1 space-y-1">{failures?.map((mutation) => <div key={mutation.id} className="flex items-center gap-2"><p className="min-w-0 flex-1 text-xs text-zinc-500 truncate" title={mutation.lastError ?? ''}>{mutation.resourceId}: {mutation.lastError || 'Request failed'}</p><DiscardButton mutationId={mutation.id} disabled={busy} /></div>)}</div><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void retry()} disabled={busy} className="inline-flex items-center gap-1 rounded bg-blue-500 px-3 py-1.5 text-xs text-white disabled:opacity-50"><RefreshCw className={cn('w-3 h-3', busy && 'animate-spin')} /> Retry failed</button><button type="button" onClick={() => void discardHistory()} disabled={busy || recoveryInProgress} className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-600 dark:border-red-900/60 dark:text-red-400 disabled:opacity-50">Clear sync history</button></div></section>}
      {(conflicts?.length ?? 0) > 0 && <section className="mt-5"><h3 className="text-xs font-semibold uppercase text-amber-600">Conflicts ({conflicts?.length})</h3><div className="mt-2 space-y-3">{conflicts?.map((mutation) => <ConflictRow key={mutation.id} mutation={mutation} />)}</div>{(failures?.length ?? 0) === 0 && <button type="button" onClick={() => void discardHistory()} disabled={busy || recoveryInProgress} className="mt-3 rounded border border-red-200 px-3 py-1.5 text-xs text-red-600 dark:border-red-900/60 dark:text-red-400 disabled:opacity-50">Clear sync history</button>}</section>}
      {(remoteMissing?.length ?? 0) > 0 && <section className="mt-5"><h3 className="text-xs font-semibold uppercase text-amber-600">Remote notes deleted ({remoteMissing?.length})</h3><div className="mt-2 space-y-3">{remoteMissing?.map((mutation) => <RemoteMissingRow key={mutation.id} mutation={mutation} />)}</div><button type="button" onClick={() => void discardHistory()} disabled={busy || recoveryInProgress} className="mt-3 rounded border border-red-200 px-3 py-1.5 text-xs text-red-600 dark:border-red-900/60 dark:text-red-400 disabled:opacity-50">Clear sync history</button></section>}
    </div>
  </div>;
}

function RemoteMissingRow({ mutation }: { mutation: import('../db/db').PendingMutation }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recover = async (choice: 'recreate' | 'delete') => {
    setBusy(true);
    setError(null);
    try {
      const local = await db.notes.get(mutation.resourceId);
      if (!local) throw new Error('Local note is no longer available');
      if (choice === 'recreate') await resolveRemoteMissingKeepMine(mutation.id, local);
      else await resolveRemoteMissingDeleteLocal(mutation.id, mutation.resourceId);
    } catch (recoveryError) {
      setError(recoveryError instanceof Error ? recoveryError.message : 'Recovery failed');
    } finally { setBusy(false); }
  };
  return <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 p-3"><p className="text-xs text-zinc-600 dark:text-zinc-300 truncate">Note {mutation.resourceId}</p>{error && <p role="alert" className="mt-2 text-[11px] text-red-600 dark:text-red-400">{error}</p>}<div className="mt-2 flex flex-wrap gap-1.5"><button disabled={busy} onClick={() => void recover('recreate')} className="rounded bg-amber-500 px-2 py-1 text-[11px] text-white">Recreate from local</button><button disabled={busy} onClick={() => void recover('delete')} className="rounded bg-red-100 px-2 py-1 text-[11px] text-red-700 dark:bg-red-950/50 dark:text-red-300">Delete local</button></div></div>;
}

function DiscardButton({ mutationId, disabled }: { mutationId: string; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const discard = async () => {
    if (!window.confirm('Discard this sync record? The local change will no longer be retried.')) return;
    setBusy(true);
    try { await discardSyncMutation(mutationId); } finally { setBusy(false); }
  };
  return <button type="button" onClick={() => void discard()} disabled={disabled || busy} className="shrink-0 text-[10px] text-red-500 hover:underline disabled:opacity-50">Discard</button>;
}

function ConflictRow({ mutation }: { mutation: import('../db/db').PendingMutation }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteMissing, setRemoteMissing] = useState(false);

  const resolve = async (choice: 'remote' | 'mine' | 'both') => {
    setBusy(true);
    setError(null);
    try {
      const local = await db.notes.get(mutation.resourceId);
      if (!local) throw new Error('Local note is no longer available');
      const remote = await api.getNote(mutation.resourceId);
      if (choice === 'remote') await resolveUseRemote(mutation.id, remote);
      else if (choice === 'mine') await resolveKeepMine(mutation.id, remote.version);
      else await resolveKeepBoth(mutation.id, local, remote);
    } catch (resolveError) {
      const status = (resolveError as Error & { status?: number }).status;
      if (status === 404) {
        await markRemoteMissing(mutation.id);
        setRemoteMissing(true);
        setError('Remote note no longer exists. Choose how to recover the local copy.');
      } else {
        setError(resolveError instanceof Error ? resolveError.message : 'Conflict resolution failed');
      }
    } finally { setBusy(false); }
  };

  const recover = async (choice: 'recreate' | 'delete') => {
    setBusy(true);
    setError(null);
    try {
      const local = await db.notes.get(mutation.resourceId);
      if (!local) throw new Error('Local note is no longer available');
      if (choice === 'recreate') {
        await resolveRemoteMissingKeepMine(mutation.id, local);
      } else {
        await resolveRemoteMissingDeleteLocal(mutation.id, mutation.resourceId);
      }
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : 'Recovery failed');
    } finally { setBusy(false); }
  };

  return <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 p-3">
    <p className="text-xs text-zinc-600 dark:text-zinc-300 truncate">Note {mutation.resourceId}</p>
    {error && <p role="alert" className="mt-2 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    {remoteMissing ? (
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] text-zinc-500">Remote deleted:</span>
        <button disabled={busy} onClick={() => void recover('recreate')} className="rounded bg-amber-500 px-2 py-1 text-[11px] text-white">Recreate from local</button>
        <button disabled={busy} onClick={() => void recover('delete')} className="rounded bg-red-100 px-2 py-1 text-[11px] text-red-700 dark:bg-red-950/50 dark:text-red-300">Delete local</button>
      </div>
    ) : (
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button disabled={busy} onClick={() => void resolve('remote')} className="rounded bg-zinc-100 dark:bg-zinc-800 px-2 py-1 text-[11px]">Use remote</button>
        <button disabled={busy} onClick={() => void resolve('mine')} className="rounded bg-amber-500 px-2 py-1 text-[11px] text-white">Keep mine</button>
        <button disabled={busy} onClick={() => void resolve('both')} className="rounded bg-blue-500 px-2 py-1 text-[11px] text-white">Keep both</button>
      </div>
    )}
  </div>;
}
