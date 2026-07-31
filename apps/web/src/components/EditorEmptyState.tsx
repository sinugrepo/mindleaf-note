import React from 'react';
import { FileText } from 'lucide-react';

export function EditorEmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-600 p-8 text-center pt-24 md:pt-8">
      <FileText className="w-16 h-16 mb-4 opacity-50" />
      <p className="text-lg">Select a note or create a new one to start writing.</p>
      <div className="mt-8 text-sm flex-wrap justify-center flex gap-6">
        <div className="flex flex-col items-center gap-2">
          <kbd className="px-2 py-1 bg-zinc-100 dark:bg-zinc-800 rounded text-xs">Ctrl + N</kbd>
          <span>New Note</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <kbd className="px-2 py-1 bg-zinc-100 dark:bg-zinc-800 rounded text-xs">Ctrl + Shift + N</kbd>
          <span>New Child Note</span>
        </div>
      </div>
    </div>
  );
}
