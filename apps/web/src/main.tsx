import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { gcAttachments } from './db/db';
import { purgeOldTrash } from './lib/notes';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Fire-and-forget orphan cleanup for the attachments table. Runs once
// per app load so an attachment deleted by editing a note (or one that
// references a note later deleted) eventually disappears from disk.
// Errors are logged but never surfaced to the user — GC is best-effort.
gcAttachments().catch((err) => {
  console.warn('Attachment GC failed:', err);
});

// Fire-and-forget trash purge: hard-delete soft-deleted notes that have
// sat in trash for more than TRASH_RETENTION_MS (default 30 days). The
// corresponding attachment rows are cascade-deleted in the helper.
purgeOldTrash().then((n) => {
  if (n > 0) console.log(`Auto-purged ${n} old trash item(s).`);
}).catch((err) => {
  console.warn('Trash purge failed:', err);
});
