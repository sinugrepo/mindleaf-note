import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearNoteHistory,
  historySize,
  recordNoteChange,
  redoLastNoteChange,
  undoLastNoteChange,
} from '../lib/note-history';
import { htmlToSnippet, sanitizeHtml } from '../lib/sanitize';

describe('priority feature helpers', () => {
  beforeEach(() => {
    clearNoteHistory();
  });

  describe('sanitizeHtml', () => {
    it('removes scripts, event handlers, unsafe URLs, and unsafe CSS', () => {
      const result = sanitizeHtml(
        '<p onclick="alert(1)">Safe</p><script>alert(2)</script>' +
          '<a href="javascript:alert(3)">bad</a>' +
          '<img src="https://example.com/a.png" style="background:url(javascript:x)">',
      );

      expect(result).toContain('Safe');
      expect(result).not.toContain('<script');
      expect(result).not.toContain('onclick');
      expect(result).not.toContain('javascript:');
      expect(result).not.toContain('background');
    });

    it('preserves TipTap task and wiki-link attributes', () => {
      const result = sanitizeHtml(
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">Task</li></ul>' +
          '<span data-wikilink-id="note-1">Link</span>',
      );

      expect(result).toContain('data-type="taskList"');
      expect(result).toContain('data-checked="true"');
      expect(result).toContain('data-wikilink-id="note-1"');
    });

    it('produces plain text snippets without markup', () => {
      expect(htmlToSnippet('<h1>Hello</h1><p>world</p>')).toBe('Hello world');
    });
  });

  describe('note history', () => {
    it('undoes and redoes a queued tree update', async () => {
      recordNoteChange({
        noteId: 'note-1',
        before: { parentId: null, order: 1 },
        after: { parentId: 'folder-1', order: 20 },
      });
      const apply = vi.fn().mockResolvedValue(undefined);

      await undoLastNoteChange(apply);
      expect(apply).toHaveBeenLastCalledWith('note-1', { parentId: null, order: 1 });
      expect(historySize()).toEqual({ undo: 0, redo: 1 });

      await redoLastNoteChange(apply);
      expect(apply).toHaveBeenLastCalledWith('note-1', { parentId: 'folder-1', order: 20 });
      expect(historySize()).toEqual({ undo: 1, redo: 0 });
    });

    it('restores the undo stack when replay fails', async () => {
      recordNoteChange({ noteId: 'note-1', before: { title: 'A' }, after: { title: 'B' } });
      const apply = vi.fn().mockRejectedValue(new Error('offline'));

      await expect(undoLastNoteChange(apply)).rejects.toThrow('offline');
      expect(historySize()).toEqual({ undo: 1, redo: 0 });
    });
  });
});
