/**
 * Phase 8 — Onboarding Wizard orchestrator hook.
 *
 * Drives the detection + decision flow for users logging into a fresh
 * cloud account whose local IndexedDB already has notes / images:
 *
 *   detecting ──► show ──► uploading ──► complete (2s) ──► hide
 *                  │
 *                  └──► fresh-confirm ──► fresh ──► hide
 *
 * Trigger condition (per CLOUD_MIGRATION_PLAN.md §12):
 *   `hasSession && getMeInfo().noteCount === 0 && localActiveNotes > 0`
 *
 * The wizard is fully mounted at App.tsx root BEFORE <Layout /> /
 * useSyncEngine, so the regular sync engine cannot race with bulk
 * uploads: while the wizard is active, the engine hasn't been started.
 *
 * The two user actions:
 *   - `startUpload()` — runs bulkUploadNotes + bulkUploadAttachments
 *     from upload-runner.ts. Each successful row stamps
 *     `lastSyncedAt = Date.now()` so a re-mount resumes only on
 *     unprocessed rows.
 *   - `startFresh()` — confirms then drops notes + attachments +
 *     pendingMutations from IndexedDB. The server's snapshot is
 *     already empty (noteCount === 0 was the trigger), so no
 *     follow-up pull is needed — sync engine after wizard will
 *     naturally pull an empty delta.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../db/db';
import { api, hasSession } from '../api/client';
import { isActiveNote } from '../lib/notes';
import {
  bulkUploadNotes,
  bulkUploadAttachments,
  NoteProgress,
  AttachmentProgress,
} from './upload-runner';

export type WizardPhase =
  | 'detecting'
  | 'show'
  | 'uploading'
  | 'fresh-confirm'
  | 'fresh'
  | 'complete'
  | 'hide';

export interface WizardProgress {
  notesUploaded: number;
  totalNotes: number;
  imagesUploaded: number;
  totalImages: number;
}

export interface WizardState {
  phase: WizardPhase;
  /** Snapshot of local counts at detection time (display only — the
   * bulk runners re-count at execution time, so this is just for the
   * welcome line of the modal). */
  localNoteCount: number;
  localAttachmentCount: number;
  progress: WizardProgress;
  /** Last error message captured during upload/clear. Surfaced in modal. */
  error: string | null;
}

const INITIAL_PROGRESS: WizardProgress = {
  notesUploaded: 0,
  totalNotes: 0,
  imagesUploaded: 0,
  totalImages: 0,
};

const INITIAL_STATE: WizardState = {
  phase: 'detecting',
  localNoteCount: 0,
  localAttachmentCount: 0,
  progress: INITIAL_PROGRESS,
  error: null,
};

/**
 * Hook entry — caller mounts only ONE instance at App.tsx root.
 *
 * The detection effect runs once on mount AND whenever the user logs
 * in (we observe `hasSession()` after the apiFetch wrapper toggles it
 * — either via login or via a 401 session expiry).
 */
export function useOnboardingWizard(): WizardState & {
  startUpload: () => Promise<void>;
  /** Drives the wizard's `show`→`fresh-confirm` transition. Does NOT
   * perform any clearing — clearing is gated behind `startFresh()`
   * which is bound to the destructive-confirm button only. */
  requestFreshConfirm: () => void;
  /** Perform the destructive clear — bound only to the confirm button. */
  startFresh: () => Promise<void>;
  cancelFresh: () => void;
} {
  const [state, setState] = useState<WizardState>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Used to enforce a serial detection: a re-detection kicked off
   * mid-upload must be ignored (the first one's results stand).
   */
  const detectionEndedRef = useRef<boolean>(false);

  useEffect(() => {
    if (detectionEndedRef.current) return;
    void detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detect = useCallback(async () => {
    setState((s) => ({ ...s, phase: 'detecting', error: null }));

    // Count local active notes + total attachments independently of
    // session — a user might log in, decide no, log back in later.
    const [allNotes, allAttachments] = await Promise.all([
      db.notes.toArray(),
      db.attachments.toArray(),
    ]);
    const localActive = allNotes.filter(isActiveNote).length;
    const localAttachments = allAttachments.length;

    // No session → no wizard. (A pre-login user has nothing to upload.)
    if (!hasSession()) {
      detectionEndedRef.current = true;
      setState((s) => ({
        ...s,
        phase: 'hide',
        localNoteCount: localActive,
        localAttachmentCount: localAttachments,
      }));
      return;
    }

    // Server-side empty cloud? Probe via /me/info. If the probe itself
    // fails (network), default to HIDE (the wizard is a best-effort
    // niceness, not a blocker — regular sync will catch up).
    let serverNoteCount = 0;
    try {
      const me = await api.getMeInfo();
      serverNoteCount = me.noteCount;
    } catch {
      detectionEndedRef.current = true;
      setState((s) => ({
        ...s,
        phase: 'hide',
        localNoteCount: localActive,
        localAttachmentCount: localAttachments,
      }));
      return;
    }

    detectionEndedRef.current = true;

    const shouldShow =
      localActive > 0 &&
      serverNoteCount === 0 &&
      // Don't show wizard if every local note is already marked synced
      // (resume scenario where upload finished in a prior session).
      allNotes.some(
        (n) => isActiveNote(n) && n.lastSyncedAt == null,
      );

    setState((s) => ({
      ...s,
      phase: shouldShow ? 'show' : 'hide',
      localNoteCount: localActive,
      localAttachmentCount: localAttachments,
    }));
  }, []);

  const startUpload = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setState((s) => ({
      ...s,
      phase: 'uploading',
      error: null,
      progress: { ...INITIAL_PROGRESS },
    }));

    try {
      // Step 1 — notes
      const notesResult = await bulkUploadNotes(
        ({ notesUploaded, totalNotes }: NoteProgress) => {
          setState((s) => ({
            ...s,
            progress: {
              ...s.progress,
              notesUploaded,
              totalNotes,
            },
          }));
        },
        abortRef.current.signal,
      );

      if (abortRef.current.signal.aborted) {
        return; // user navigated away or aborted
      }

      // Step 2 — attachments (re-check abort between steps so a user
      // navigating away mid-orchestration can't trigger a half-baked
      // PUT burst).
      const attResult = await bulkUploadAttachments(
        ({ imagesUploaded, totalImages }: AttachmentProgress) => {
          setState((s) => ({
            ...s,
            progress: {
              ...s.progress,
              imagesUploaded,
              totalImages,
            },
          }));
        },
        abortRef.current.signal,
      );

      // Brief completion screen — auto-dismiss after 2s.
      setState((s) => ({
        ...s,
        phase: 'complete',
        error:
          notesResult.notOk + attResult.notOk > 0
            ? `${notesResult.notOk + attResult.notOk} items failed to upload — re-open this wizard to retry.`
            : null,
      }));
      setTimeout(() => {
        setState((s) => ({ ...s, phase: 'hide' }));
      }, 2000);
    } catch (err) {
      setState((s) => ({
        ...s,
        phase: 'show',
        error:
          err instanceof Error ? err.message : 'Upload failed unexpectedly.',
      }));
    }
  }, []);

  const startFresh = useCallback(async () => {
    // Transition to the 'fresh' rendering phase first so the modal
    // shows a transient "Clearing local data…" state, then perform
    // the destroy during which the modal is still mounted.
    setState((s) => ({ ...s, phase: 'fresh', error: null }));

    // Clear user-facing local data. We intentionally KEEP `syncState`
    // (deviceId, lastSyncedAt) so the next sync layer pull uses the
    // same device identity — useful for future conflict traces.
    try {
      await db.transaction(
        'rw',
        db.notes,
        db.attachments,
        db.pendingMutations,
        async () => {
          await db.notes.clear();
          await db.attachments.clear();
          await db.pendingMutations.clear();
        },
      );
      setState((s) => ({ ...s, phase: 'hide' }));
    } catch (err) {
      setState((s) => ({
        ...s,
        phase: 'show',
        error:
          err instanceof Error
            ? `Failed to clear local data: ${err.message}`
            : 'Failed to clear local data.',
      }));
    }
  }, []);

  const requestFreshConfirm = useCallback(() => {
    setState((s) => ({ ...s, phase: 'fresh-confirm' }));
  }, []);

  const cancelFresh = useCallback(() => {
    setState((s) => ({ ...s, phase: 'show' }));
  }, []);

  return {
    ...state,
    startUpload,
    startFresh,
    requestFreshConfirm,
    cancelFresh,
  };
}
