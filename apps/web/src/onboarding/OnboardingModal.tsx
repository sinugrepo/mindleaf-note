/**
 * Phase 8 — Onboarding Modal (presentational only).
 *
 * Driven entirely by `useOnboardingWizard()` state. Renders five
 * visual stages that map to wizard phases:
 *
 *   detecting  → null (caller still shows a transient loading screen)
 *   show       → welcome card + 2-button CTA (Upload / Start fresh)
 *   uploading  → progress bar + counts (notes + images)
 *   fresh-confirm → irreversibility dialog
 *   fresh      → brief "clearing…" indicator
 *   complete   → success / partial-success message
 *   hide       → null (caller renders <Layout />)
 *
 * Visual style follows the project's glassmorphic surface language
 * (existing modals in the repo use `bg-white/50 backdrop-blur-xl`,
 * motion transitions, lucide-react icons).
 */

import React, { useEffect } from 'react';
import {
  Cloud,
  CloudUpload,
  Sparkles,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import type { WizardState } from './useOnboardingWizard';

interface OnboardingModalProps {
  state: WizardState;
  /** Upload-everything CTA — runs the bulk upload. Called on welcome;
   * also wired to the partial-failure "Retry" button on complete. */
  onStartUpload: () => void;
  /** Show the irreversible "Start fresh" confirm panel. */
  onRequestFreshConfirm: () => void;
  /** Called by <FreshConfirm>'s destructive button. Performs the clear. */
  onConfirmFresh: () => void;
  /** Cancel the fresh-confirm dialog — returns to the welcome panel. */
  onCancelFresh: () => void;
}

export function OnboardingModal({
  state,
  onStartUpload,
  onRequestFreshConfirm,
  onConfirmFresh,
  onCancelFresh,
}: OnboardingModalProps) {
  // Detect Escape → equivalent of "Start fresh cancelled" only when in
  // confirm mode. We don't expose an Escape to dismiss the welcome
  // screen because the spec is explicit about two-button design.
  useEffect(() => {
    if (state.phase !== 'fresh-confirm') return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelFresh();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [state.phase, onCancelFresh]);

  if (state.phase === 'detecting' || state.phase === 'hide') {
    return null;
  }

  // Visual container — fixed full-screen backdrop with centered card,
  // matching the existing full-screen modals in Sidebar (theme toggle,
  // trash view, etc.) for visual consistency.
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-zinc-900/30 dark:bg-black/60 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="glass-modal w-full max-w-lg rounded-2xl shadow-2xl border border-white/60 dark:border-white/10 bg-white/80 dark:bg-[#0a0a0c]/80 backdrop-blur-xl overflow-hidden">
        {(state.phase === 'show' || state.phase === 'uploading' ||
          state.phase === 'fresh' || state.phase === 'complete') && (
          <Welcome
            state={state}
            onStartUpload={onStartUpload}
            onRequestFreshConfirm={onRequestFreshConfirm}
          />
        )}
        {state.phase === 'fresh-confirm' && (
          <FreshConfirm
            onConfirm={onConfirmFresh}
            onCancel={onCancelFresh}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Welcome: detection card + 2-button CTA + Upload progress + Complete
// ---------------------------------------------------------------------------

function Welcome({
  state,
  onStartUpload,
  onRequestFreshConfirm,
}: Pick<
  OnboardingModalProps,
  'onStartUpload' | 'onRequestFreshConfirm'
> & {
  state: WizardState;
}) {
  const uploading = state.phase === 'uploading';
  const fresh = state.phase === 'fresh';
  const complete = state.phase === 'complete';
  const totalNotes = state.progress.totalNotes || state.localNoteCount;
  const totalImages =
    state.progress.totalImages || state.localAttachmentCount;
  const notesRatio =
    totalNotes === 0 ? 0 : state.progress.notesUploaded / totalNotes;
  const imagesRatio =
    totalImages === 0 ? 0 : state.progress.imagesUploaded / totalImages;

  return (
    <>
      {/* Icon header — picks the icon by phase so the user sees the
          progress morphing visually without re-reading the text. */}
      <div className="px-7 pt-7 pb-3 flex items-start gap-4">
        <div
          className={[
            'shrink-0 grid place-items-center w-12 h-12 rounded-xl',
            'bg-gradient-to-br from-blue-500/20 via-indigo-500/20 to-violet-500/20',
            'border border-white/60 dark:border-white/10',
          ].join(' ')}
        >
          {complete ? (
            <CheckCircle2 className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
          ) : uploading || fresh ? (
            <Loader2 className="w-6 h-6 text-blue-600 dark:text-blue-400 animate-spin" />
          ) : (
            <Cloud className="w-6 h-6 text-blue-600 dark:text-blue-400" />
          )}
        </div>
        <div className="min-w-0">
          <h2
            id="onboarding-title"
            className="text-lg font-semibold text-zinc-900 dark:text-zinc-100"
          >
            {complete
              ? 'Ready to sync.'
              : uploading
                ? 'Uploading to cloud…'
                : fresh
                  ? 'Clearing local data…'
                  : 'Welcome to Mindleaf Cloud'}
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {complete ? (
              <>
                {state.error ? (
                  <span className="text-orange-600 dark:text-orange-400">
                    {state.error}
                  </span>
                ) : (
                  <span>
                    Synced {state.progress.notesUploaded} notes &{' '}
                    {state.progress.imagesUploaded} images.
                  </span>
                )}
              </>
            ) : uploading || fresh ? (
              <span className="tabular-nums">
                {fresh ? 'Preparing a clean slate' : 'Working…'}
              </span>
            ) : (
              <>
                We found{' '}
                <strong className="text-zinc-800 dark:text-zinc-200 tabular-nums">
                  {state.progress.totalNotes || state.localNoteCount} note
                  {(state.progress.totalNotes || state.localNoteCount) === 1
                    ? ''
                    : 's'}
                </strong>{' '}
                and{' '}
                <strong className="text-zinc-800 dark:text-zinc-200 tabular-nums">
                  {state.progress.totalImages || state.localAttachmentCount}{' '}
                  image
                  {(state.progress.totalImages || state.localAttachmentCount) ===
                  1
                    ? ''
                    : 's'}
                </strong>{' '}
                to upload.
              </>
            )}
          </p>
        </div>
      </div>

      {/* Progress bar — visible only during upload. Render two thin
          stacked bars so the user sees both legs (notes + images) at
          the same time. */}
      {(uploading || complete) && (
        <div className="px-7 py-3 space-y-2">
          <ProgressRow
            label="Notes"
            current={state.progress.notesUploaded}
            total={totalNotes}
            ratio={notesRatio}
          />
          <ProgressRow
            label="Images"
            current={state.progress.imagesUploaded}
            total={totalImages}
            ratio={imagesRatio}
          />
        </div>
      )}

      {/* Action area — terminated during upload/fresh/complete. */}
      {state.phase === 'show' && (
        <div className="px-7 pb-7 pt-1 flex flex-col gap-3">
          {state.error && (
            <div className="flex items-center gap-2 text-xs text-orange-700 dark:text-orange-300 bg-orange-100/60 dark:bg-orange-900/30 rounded-md px-3 py-2 border border-orange-200/60 dark:border-orange-700/40">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{state.error}</span>
            </div>
          )}
          <button
            type="button"
            onClick={onStartUpload}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white text-sm font-medium shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 transition-all duration-200"
          >
            <CloudUpload className="w-4 h-4" />
            Upload everything to cloud
          </button>
          <button
            type="button"
            onClick={onRequestFreshConfirm}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-white/70 hover:bg-white dark:bg-zinc-800/60 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-sm font-medium border border-zinc-200/70 dark:border-zinc-700/60 transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            Start fresh
          </button>
          <p className="text-[11px] text-center text-zinc-500 dark:text-zinc-500 mt-1">
            You can close this tab anytime — uploads persist server-side.
          </p>
        </div>
      )}

      {complete && (
        <div className="px-7 pb-7 pt-1 space-y-3">
          <p className="text-xs text-zinc-500 dark:text-zinc-500 text-center">
            {state.error
              ? 'You can retry the failed items, or close this tab and re-open to resume automatically.'
              : 'Loading your workspace…'}
          </p>
          {state.error && (
            <button
              type="button"
              onClick={onStartUpload}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium shadow-lg shadow-blue-500/20 transition-all"
            >
              Retry failed items
            </button>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Progress row — label + numeric counts + bar
// ---------------------------------------------------------------------------

function ProgressRow({
  label,
  current,
  total,
  ratio,
}: {
  label: string;
  current: number;
  total: number;
  ratio: number;
}) {
  const pct = Math.min(100, Math.round(ratio * 100));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-zinc-700 dark:text-zinc-300">
        <span>{label}</span>
        <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
          {current} / {total}
        </span>
      </div>
      <div className="h-1.5 w-full bg-zinc-200/70 dark:bg-zinc-700/50 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-[width] duration-200 ease-out"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fresh-confirm: irreversibility warning
// ---------------------------------------------------------------------------

function FreshConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="p-7 space-y-4">
      <div className="flex items-start gap-4">
        <div className="shrink-0 grid place-items-center w-12 h-12 rounded-xl bg-red-100/70 dark:bg-red-900/30 border border-red-200/60 dark:border-red-700/40">
          <Trash2 className="w-6 h-6 text-red-600 dark:text-red-400" />
        </div>
        <div>
          <h2
            id="onboarding-title"
            className="text-lg font-semibold text-zinc-900 dark:text-zinc-100"
          >
            Start fresh — are you sure?
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            This permanently deletes every local note and image from
            this browser. The cloud account has no data, so you will
            start with an empty workspace.
          </p>
        </div>
      </div>
      <div className="rounded-lg border border-red-200/70 dark:border-red-700/40 bg-red-50/60 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
        This action <strong>cannot be undone</strong>.
      </div>
      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:items-center sm:justify-end pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-lg bg-white/70 hover:bg-white dark:bg-zinc-800/60 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-sm font-medium border border-zinc-200/70 dark:border-zinc-700/60 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium shadow-lg shadow-red-500/20 transition-all"
        >
          Yes, delete all local data
        </button>
      </div>
    </div>
  );
}
