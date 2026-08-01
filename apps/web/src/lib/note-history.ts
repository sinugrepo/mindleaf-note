import type { Note } from '../types';

export type HistoryField = 'title' | 'content' | 'isExpanded' | 'order' | 'parentId' | 'tags';
export type HistoryUpdates = Partial<Pick<Note, HistoryField>>;

export interface NoteHistoryEntry {
  noteId: string;
  before: HistoryUpdates;
  after: HistoryUpdates;
}

const MAX_HISTORY = 100;
const undoStack: NoteHistoryEntry[] = [];
const redoStack: NoteHistoryEntry[] = [];
let replaying = false;

export function recordNoteChange(entry: NoteHistoryEntry): void {
  if (replaying || Object.keys(entry.before).length === 0) return;
  undoStack.push(entry);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

export function isHistoryReplay(): boolean {
  return replaying;
}

export function withHistoryReplay<T>(operation: () => Promise<T>): Promise<T> {
  replaying = true;
  return operation().finally(() => {
    replaying = false;
  });
}

export async function undoLastNoteChange(
  apply: (noteId: string, updates: HistoryUpdates) => Promise<void>,
): Promise<NoteHistoryEntry | null> {
  const entry = undoStack.pop() ?? null;
  if (!entry) return null;
  try {
    await withHistoryReplay(() => apply(entry.noteId, entry.before));
    redoStack.push(entry);
    return entry;
  } catch (error) {
    undoStack.push(entry);
    throw error;
  }
}

export async function redoLastNoteChange(
  apply: (noteId: string, updates: HistoryUpdates) => Promise<void>,
): Promise<NoteHistoryEntry | null> {
  const entry = redoStack.pop() ?? null;
  if (!entry) return null;
  try {
    await withHistoryReplay(() => apply(entry.noteId, entry.after));
    undoStack.push(entry);
    return entry;
  } catch (error) {
    redoStack.push(entry);
    throw error;
  }
}

export function clearNoteHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

export function historySize(): { undo: number; redo: number } {
  return { undo: undoStack.length, redo: redoStack.length };
}
