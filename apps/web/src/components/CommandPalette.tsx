import React, { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

export interface CommandItem { id: string; label: string; shortcut?: string; run: () => void | Promise<void>; }

export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: CommandItem[] }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (open) { setQuery(''); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  if (!open) return null;
  const filtered = commands.filter((command) => command.label.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="fixed inset-0 z-[120] flex items-start justify-center pt-[15vh] bg-black/20 dark:bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="command-palette-title" className="w-[min(92vw,520px)] overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <h2 id="command-palette-title" className="sr-only">Command palette</h2>
        <div className="flex items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-3">
          <Search className="w-4 h-4 text-zinc-400" />
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} placeholder="Type a command…" aria-label="Search commands" className="flex-1 bg-transparent py-3 text-sm outline-none dark:text-zinc-100" />
          <button type="button" onClick={onClose} aria-label="Close command palette"><X className="w-4 h-4 text-zinc-400" /></button>
        </div>
        <div role="listbox" className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? <p className="p-4 text-sm text-zinc-500">No commands found.</p> : filtered.map((command) => (
            <button key={command.id} type="button" role="option" onClick={() => { void command.run(); onClose(); }} className="w-full flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:text-zinc-200">
              <span>{command.label}</span>{command.shortcut && <kbd className="text-[10px] text-zinc-400">{command.shortcut}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
