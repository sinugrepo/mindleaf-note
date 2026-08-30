import React, { useEffect, useState } from 'react';
import { Cloud, Loader2, LogIn, RefreshCw, WifiOff } from 'lucide-react';
import { api, checkSession, setHasSession } from '../api/client';

interface AuthGateProps {
  children: (onLogout: () => Promise<void>) => React.ReactNode;
}

type GatePhase = 'checking' | 'login' | 'offline' | 'authenticated';

/**
 * Owns the browser session lifecycle. The backend uses an HttpOnly cookie,
 * so the frontend must validate that cookie once after every page load before
 * mounting the sync engine.
 */
export function AuthGate({ children }: AuthGateProps) {
  const [phase, setPhase] = useState<GatePhase>('checking');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localOnly, setLocalOnly] = useState(false);

  const probe = async () => {
    setPhase('checking');
    setError(null);
    try {
      await checkSession();
      setLocalOnly(false);
      setPhase('authenticated');
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        setPhase('login');
        return;
      }
      setPhase('offline');
      setError('Backend tidak dapat dijangkau. Periksa server atau lanjutkan sementara secara lokal.');
    }
  };

  useEffect(() => {
    void probe();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = password;
    if (!value) {
      setError('Password wajib diisi.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // The initial account is created through the server-side CLI seed
      // command during provisioning. Browser auth only logs in.
      await api.login({ password: value });
      setLocalOnly(false);
      setPassword('');
      setPhase('authenticated');
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        setError('Akun belum dibuat. Jalankan perintah seed di server terlebih dahulu.');
      } else {
        setError(err instanceof Error ? err.message : 'Autentikasi gagal.');
      }
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await api.logout();
    setPassword('');
    setLocalOnly(false);
    setPhase('login');
  };

  if (phase === 'authenticated') {
    return (
      <>
        {localOnly && (
          <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[200] flex items-center gap-3 rounded-full border border-amber-200 dark:border-amber-800/60 bg-amber-50/95 dark:bg-amber-950/95 px-4 py-2 text-xs text-amber-800 dark:text-amber-200 shadow-lg backdrop-blur-md">
            <WifiOff className="w-3.5 h-3.5 shrink-0" />
            <span>Mode lokal — perubahan belum tersinkron ke cloud.</span>
            <button type="button" onClick={() => void probe()} className="font-semibold underline underline-offset-2 hover:text-amber-950 dark:hover:text-white">Hubungkan</button>
          </div>
        )}
        {children(logout)}
      </>
    );
  }

  if (phase === 'checking') {
    return (
      <div className="min-h-screen grid place-items-center bg-sky-50 dark:bg-[#030303]">
        <Loader2 className="w-8 h-8 text-blue-600 dark:text-blue-400 animate-spin" aria-label="Memeriksa sesi" />
      </div>
    );
  }

  if (phase === 'offline') {
    return (
      <div className="min-h-screen grid place-items-center p-6 bg-sky-50 dark:bg-[#030303]">
        <div className="w-full max-w-md rounded-2xl border border-white/70 dark:border-white/10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl shadow-2xl p-8 text-center">
          <div className="mx-auto grid place-items-center w-14 h-14 rounded-2xl bg-amber-100 dark:bg-amber-900/30">
            <WifiOff className="w-7 h-7 text-amber-600 dark:text-amber-400" />
          </div>
          <h1 className="mt-5 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Backend belum terhubung</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{error}</p>
          <div className="mt-6 flex flex-col gap-2">
            <button type="button" onClick={() => void probe()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2.5 text-sm font-medium text-white transition-colors">
              <RefreshCw className="w-4 h-4" /> Coba lagi
            </button>
            <button type="button" onClick={() => { setError(null); setPhase('login'); }} className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-4 py-2.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
              Masuk / buat akun
            </button>
            <button type="button" onClick={() => { setHasSession(false); setLocalOnly(true); setPhase('authenticated'); }} className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors">
              <WifiOff className="w-3.5 h-3.5" /> Lanjutkan lokal sementara
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-theme="dark" className="relative min-h-screen overflow-hidden grid place-items-center p-6 !bg-[#05070d] bg-[radial-gradient(circle_at_15%_10%,#172554_0%,transparent_38%),radial-gradient(circle_at_85%_15%,#312e81_0%,transparent_42%),radial-gradient(circle_at_50%_100%,#0f172a_0%,transparent_55%)]">
      <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-blue-400/20 blur-3xl dark:bg-blue-500/10" />
      <div className="pointer-events-none absolute -right-24 bottom-0 h-80 w-80 rounded-full bg-violet-400/20 blur-3xl dark:bg-violet-500/10" />
      <div className="relative w-full max-w-md rounded-2xl border border-blue-200/10 bg-slate-950/90 backdrop-blur-xl shadow-2xl shadow-black/50 p-8">
        <div className="flex items-center gap-3">
          <div className="grid place-items-center w-12 h-12 rounded-xl bg-slate-900 border border-blue-200/10 shadow-lg shadow-blue-950/40 overflow-hidden">
            <img src="/logo.png" alt="Mindleaf" className="h-10 w-10 object-contain" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <Cloud className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Mindleaf Cloud</span>
            </div>
            <h1 className="text-xl font-semibold text-white">Masuk untuk sinkronisasi</h1>
          </div>
        </div>
        <p className="mt-5 text-sm leading-6 text-slate-300">
          Note tetap tersedia lokal, lalu akan disinkronkan ke PostgreSQL dan gambar ke Cloudflare R2 setelah masuk.
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block text-sm font-medium text-slate-200" htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => { setPassword(event.target.value); setError(null); }}
            placeholder="Masukkan password"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/40"
            disabled={busy}
          />
          {error && <p role="alert" className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
          <button type="submit" disabled={busy} className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 disabled:opacity-60 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-500/20 transition-all">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
            {busy ? 'Memproses…' : 'Masuk'}
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] leading-5 text-slate-400">Akun pertama dibuat oleh administrator melalui CLI. Session aman menggunakan HttpOnly cookie.</p>
      </div>
    </div>
  );
}
