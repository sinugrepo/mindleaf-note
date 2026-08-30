import type { Editor as TiptapEditor } from '@tiptap/react';
import type React from 'react';
import { cn } from '../lib/utils';
import { Code2 } from 'lucide-react';

/**
 * Lightweight formatting toolbar rendered above the TipTap editor surface.
 * Extracted from Editor.tsx so the Editor component itself stays focused on
 * state / persistence and the toolbar remains a presentational leaf.
 *
 * The toolbar receives a live TiptapEditor instance from the parent and
 * drives it directly via `editor.chain().focus().toggle…().run()` — no
 * state mirroring here, so the toolbar always reflects the actual
 * editor selection state through `editor.isActive(...)`.
 *
 * Returns null when `editor` is null (matches the inline `editor && (...)`
 * guard originally inline in Editor.tsx).
 */
export function EditorToolbar({ editor }: { editor: TiptapEditor | null }) {
  if (!editor) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 gap-y-1.5 mb-6 text-zinc-500 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-1.5 rounded-md self-start sticky top-0 z-10 shadow-sm max-w-full overflow-hidden">
      <FormatButton
        active={editor.isActive('heading', { level: 1 })}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 1 }).run()
        }
        label="H1"
      />
      <FormatButton
        active={editor.isActive('heading', { level: 2 })}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 2 }).run()
        }
        label="H2"
      />        <div className="hidden h-4 w-px bg-zinc-200 dark:bg-zinc-700 mx-1 sm:block"></div>
      <FormatButton
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
        label="B"
        className="font-bold"
      />
      <FormatButton
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        label="I"
        className="italic font-serif"
      />        <div className="hidden h-4 w-px bg-zinc-200 dark:bg-zinc-700 mx-1 sm:block"></div>
      <FormatButton
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        label="• List"
      />
      <FormatButton
        active={editor.isActive('taskList')}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        label="☑ Task"
      />
      <FormatButton
        active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        label="Code"
        icon={<Code2 className="mr-1 inline-block h-3.5 w-3.5" />}
      />        <div className="hidden h-4 w-px bg-zinc-200 dark:bg-zinc-700 mx-1 sm:block"></div>
      <button
        type="button"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().chain().focus().undo().run()}
        title="Undo (Ctrl+Z)"
        className="px-2 py-1 text-xs rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-30"
      >
        Undo
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().chain().focus().redo().run()}
        title="Redo (Ctrl+Y)"
        className="px-2 py-1 text-xs rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-30"
      >
        Redo
      </button>
    </div>
  );
}

function FormatButton({
  active,
  onClick,
  label,
  className,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  className?: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2 py-1 text-xs rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors',
        active && 'bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100',
        className,
      )}
    >
      {icon}
      {label}
    </button>
  );
}
