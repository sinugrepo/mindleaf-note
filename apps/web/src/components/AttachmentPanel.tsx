import React, { useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { FileImage, Paperclip } from 'lucide-react';
import { db } from '../db/db';
import { cn } from '../lib/utils';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentPreview({ blob, name }: { blob: Blob; name: string }) {
  const url = useMemo(() => (blob.size ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (!url) return <FileImage className="w-4 h-4 text-zinc-400" />;
  return <img src={url} alt={name || 'Attachment'} className="w-10 h-10 rounded object-cover border border-zinc-200 dark:border-zinc-700" />;
}

export function AttachmentPanel({ noteId }: { noteId: string }) {
  const attachments = useLiveQuery(
    () => db.attachments.where('noteId').equals(noteId).toArray(),
    [noteId],
    [],
  );
  if (!attachments || attachments.length === 0) return null;
  let totalBytes = 0;
  for (const attachment of attachments) totalBytes += attachment.blob.size;

  return (
    <details className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
      <summary className="cursor-pointer select-none flex items-center gap-2 hover:text-zinc-800 dark:hover:text-zinc-200">
        <Paperclip className="w-3.5 h-3.5" />
        {attachments.length} attachment{attachments.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
      </summary>
      <div className="mt-2 grid gap-1.5">
        {attachments.map((attachment) => (
          <div key={attachment.id} className={cn('flex items-center gap-2 rounded-md p-1.5', 'bg-zinc-50 dark:bg-zinc-900/60')}>
            <AttachmentPreview blob={attachment.blob} name={attachment.name} />
            <span className="truncate flex-1" title={attachment.name || attachment.mime}>{attachment.name || 'Unnamed image'}</span>
            <span className="font-mono text-[10px] shrink-0">{formatBytes(attachment.blob.size)}</span>
            <span className="text-[10px] shrink-0">{attachment.syncStatus === 'synced' ? 'Synced' : 'Local'}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
