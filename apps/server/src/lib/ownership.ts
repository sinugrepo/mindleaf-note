import { eq } from 'drizzle-orm';
import { attachments, notes, tombstones } from '../db/schema.js';

export const noteOwnedBy = (userId: string) => eq(notes.userId, userId);
export const attachmentOwnedBy = (userId: string) => eq(attachments.userId, userId);
export const tombstoneOwnedBy = (userId: string) => eq(tombstones.userId, userId);
