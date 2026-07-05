import Image from '@tiptap/extension-image';
import {
  ReactNodeViewRenderer,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from '@tiptap/react';
import React, { useRef, useState, useEffect } from 'react';
import { db } from '../db/db';
import { ATTACHMENT_SRC_PREFIX } from '../types';

/**
 * `blob:` URL cache: attachment id -> object URL.
 *
 * Persisted for the lifetime of the tab so the same attachment isn't
 * `URL.createObjectURL`'d repeatedly across:
 *   - React StrictMode mount -> unmount -> mount cycles,
 *   - Editor remounts on every note-key switch (Layout.tsx invariant),
 *   - saveStatus flips that cause parent-tree re-renders.
 *
 * Bounded leak: the cache holds one entry per attachment id inserted
 * into the db during the SESSION (not just the currently-visible ones).
 * For a personal outliner this caps at low hundreds of MB even with
 * a few thousand image edits; tab-close reclaims everything.
 *
 * The simpler alternative — refcount + revoke on last unmount — was
 * deliberately rejected: the StrictMode race condition (mount, unmount,
 * immediately remount) is hard to drive refcounts correctly without
 * bundling React state with URL ownership.
 */
const blobUrlCache = new Map<string, string>();

/**
 * Resolve a TipTap `src` attribute to a renderable URL.
 *  - `attachment:<id>`  -> looked up in db.attachments, wrapped in
 *    URL.createObjectURL.
 *  - Anything else (legacy `data:`, external `http(s):`)                -> passed
 *    through unchanged.
 *  - null / empty / unparseable                                          -> null.
 *
 * Returns null for an `attachment:` id whose row is missing so the
 * React component can render the placeholder instead of an `<img>`
 * whose src silently 404s.
 */
async function resolveImageSrc(
  src: string | null | undefined,
): Promise<string | null> {
  if (!src) return null;
  if (!src.startsWith(ATTACHMENT_SRC_PREFIX)) return src;
  const id = src.slice(ATTACHMENT_SRC_PREFIX.length);
  if (!id) return null;

  const cached = blobUrlCache.get(id);
  if (cached) return cached;

  try {
    const att = await db.attachments.get(id);
    if (!att) return null;
    const url = URL.createObjectURL(att.blob);
    blobUrlCache.set(id, url);
    return url;
  } catch {
    return null;
  }
}

export const ResizableImage = Image.extend({
  // The editor stores images as base64 data URLs (see image-upload.ts /
  // compressImage). The base Image extension defaults `allowBase64` to
  // false, which makes parseHTML reject any <img src="data:..."> tag.
  // As a result, when a note containing an inline base64 image is loaded
  // from IndexedDB via setContent, the <img> is silently stripped from
  // the ProseMirror document — the image vanishes from the editor even
  // though the full HTML (including the data URL) is still in the
  // database. Enabling allowBase64 here lets parseHTML accept data URLs
  // so images survive note switches, page reloads, and import round-trips
  // even on notes that haven't been migrated to v3 yet.
  addOptions() {
    return {
      ...this.parent?.(),
      allowBase64: true,
    };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: '100%',
        parseHTML: element => element.style.width || '100%',
        renderHTML: attributes => {
          return {
            style: `width: ${attributes.width}`,
          }
        },
      },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageResizeComponent);
  },
});

function ImageResizeComponent({
  node,
  updateAttributes,
  selected,
}: ReactNodeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
  const [direction, setDirection] = useState<'left' | 'right' | null>(null);
  const [initialWidth, setInitialWidth] = useState(0);
  const [initialX, setInitialX] = useState(0);

  // Resolve the TipTap src attribute to a renderable URL on mount and
  // whenever the underlying attachment id changes (e.g. user replaces
  // the image). Pass-through identical for non-attachment: sources so
  // legacy notes (inline base64) and external images render without
  // an unnecessary IndexedDB round-trip.
  const rawSrc = node.attrs.src;
  useEffect(() => {
    let cancelled = false;
    resolveImageSrc(rawSrc).then((url) => {
      if (!cancelled) setResolvedSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [rawSrc]);

  useEffect(() => {
    if (!resizing) return;
    
    const onMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      const diffX = e.clientX - initialX;
      let newWidth = initialWidth;
      
      if (direction === 'right') {
        newWidth = initialWidth + diffX;
      } else if (direction === 'left') {
        newWidth = initialWidth - diffX;
      }
      
      const pxWidth = Math.max(50, newWidth);
      if (containerRef.current) containerRef.current.style.width = `${pxWidth}px`;
    };
    
    const onMouseUp = (e: MouseEvent) => {
      e.preventDefault();
      setResizing(false);
      if (containerRef.current) {
        updateAttributes({ width: containerRef.current.style.width });
      }
    };
    
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [resizing, direction, initialX, initialWidth, updateAttributes]);

  const handleDragStart = (e: React.MouseEvent, dir: 'left' | 'right') => {
    e.preventDefault();
    setResizing(true);
    setDirection(dir);
    setInitialX(e.clientX);
    if (containerRef.current) {
      setInitialWidth(containerRef.current.offsetWidth);
    }
  };

  return (
    <NodeViewWrapper 
      className="inline-block relative group/image-resizer max-w-full my-2" 
      style={{ display: 'inline-block' }}
    >
      <div 
        ref={containerRef}
        style={{ width: node.attrs.width || '100%', maxWidth: '100%' }}
        className={`relative inline-block border-2 ${selected || resizing ? 'border-blue-500' : 'border-transparent hover:border-blue-300'}`}
      >
        {resolvedSrc ? (
          <img 
            src={resolvedSrc} 
            alt={node.attrs.alt}
            title={node.attrs.title}
            style={{ width: '100%', height: 'auto', display: 'block' }} 
            className="pointer-events-none rounded-sm"
          />
        ) : (
          // `attachment:` id is set but the Blob cannot be loaded (row
          // missing, IndexedDB error, etc). Render a neutral placeholder
          // so the editor stays usable and the user sees *something* is
          // broken rather than a silent <img> that 404s.
          <div 
            className="bg-zinc-100 dark:bg-zinc-800 rounded-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 text-xs italic"
            style={{ width: '100%', minHeight: '60px', padding: '0.5rem' }}
          >
            Image unavailable
          </div>
        )}
        
        {/* Handles */}
        <div
          className="absolute top-0 right-0 w-3 h-3 bg-blue-500 rounded-full -mt-1.5 -mr-1.5 cursor-nesw-resize opacity-0 group-hover/image-resizer:opacity-100 transition-opacity z-10"
          onMouseDown={(e) => handleDragStart(e, 'right')}
        />
        <div
          className="absolute bottom-0 right-0 w-3 h-3 bg-blue-500 rounded-full -mb-1.5 -mr-1.5 cursor-nwse-resize opacity-0 group-hover/image-resizer:opacity-100 transition-opacity z-10"
          onMouseDown={(e) => handleDragStart(e, 'right')}
        />
        <div
          className="absolute top-0 left-0 w-3 h-3 bg-blue-500 rounded-full -mt-1.5 -ml-1.5 cursor-nwse-resize opacity-0 group-hover/image-resizer:opacity-100 transition-opacity z-10"
          onMouseDown={(e) => handleDragStart(e, 'left')}
        />
        <div
          className="absolute bottom-0 left-0 w-3 h-3 bg-blue-500 rounded-full -mb-1.5 -ml-1.5 cursor-nesw-resize opacity-0 group-hover/image-resizer:opacity-100 transition-opacity z-10"
          onMouseDown={(e) => handleDragStart(e, 'left')}
        />
      </div>
    </NodeViewWrapper>
  );
}
