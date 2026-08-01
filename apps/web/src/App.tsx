import { Layout } from './components/Layout';
import { useSyncEngine } from './sync/useSyncEngine';
import { useOnboardingWizard } from './onboarding/useOnboardingWizard';
import { OnboardingModal } from './onboarding/OnboardingModal';
import { Loader2 } from 'lucide-react';
import { AuthGate } from './components/AuthGate';

/**
 * App root — Phase 8 introduces the onboarding gate.
 *
 * Why a gate (vs. an in-layout modal): the spam of bulk uploads must
 * NOT race with the regular sync engine. The engine runs a `pullDelta()`
 * immediately on mount and again every 60 s — if both are active in
 * parallel, the local-cache could be repopulated by a stale snapshot
 * between the wizard's batch PUTs, mixing dirty / clean rows underfoot.
 *
 * The gate works by:
 *   1. Detecting session + local-data state synchronously at mount.
 *   2. If the wizard needs to run, returning ONLY the modal (no
 *      <Layout />, no `useSyncEngine`).
 *   3. After the wizard hides, the second branch mounts both
 *      `useSyncEngine` + <Layout /> as before.
 *
 * Thus the engine never starts until the wizard is done — no race.
 */
export default function App() {
  return (
    <AuthGate>
      {(onLogout) => <AuthenticatedApp onLogout={onLogout} />}
    </AuthGate>
  );
}

function AuthenticatedApp({ onLogout }: { onLogout: () => Promise<void> }) {
  const wizard = useOnboardingWizard();

  // Wizard is active — render modal-only, no Layout, no sync engine.
  // We include `detecting` in the "active" surface so the user sees a
  // brief loading shimmer instead of the chrome smearing in for a frame
  // before the wizard appears.
  if (
    wizard.phase === 'detecting' ||
    wizard.phase === 'show' ||
    wizard.phase === 'uploading' ||
    wizard.phase === 'fresh-confirm' ||
    wizard.phase === 'fresh' ||
    wizard.phase === 'complete'
  ) {
    return (
      <>
        {wizard.phase === 'detecting' ? (
          <div className="fixed inset-0 z-50 grid place-items-center bg-white/40 dark:bg-[#09090b]/80 backdrop-blur-sm">
            <Loader2 className="w-7 h-7 text-blue-600 dark:text-blue-400 animate-spin" />
          </div>
        ) : (
          <OnboardingModal
            state={wizard}
            onStartUpload={wizard.startUpload}
            // The welcome screen's "Start fresh" button only transitions
            // INTO the irreversible confirm sub-flow — the destructive
            // clear runs only from the confirm screen's Yes button.
            onRequestFreshConfirm={wizard.requestFreshConfirm}
            onConfirmFresh={wizard.startFresh}
            onCancelFresh={wizard.cancelFresh}
          />
        )}
      </>
    );
  }

  // Wizard done / not needed — normal app shell.
  return <AppShell onLogout={onLogout} />;
}

/**
 * Inner shell — only rendered AFTER the wizard hides. Splitting it
 * into its own component guarantees `useSyncEngine` is mounted
 * strictly AFTER any wizard activity has settled.
 */
function AppShell({ onLogout }: { onLogout: () => Promise<void> }) {
  useSyncEngine();
  return <Layout onLogout={onLogout} />;
}
