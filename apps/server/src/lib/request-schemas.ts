import { z } from 'zod';
import { ALLOWED_UPLOAD_MIMES } from './upload-validation.js';

export const uuidSchema = z.string().uuid();

export const loginRequestSchema = z.object({
  password: z.string().min(1).max(1024),
}).strict();

export const noteCreateRequestSchema = z.object({
  id: uuidSchema.optional(),
  parentId: uuidSchema.nullable().optional(),
  title: z.string().max(500).default(''),
  content: z.string().max(10 * 1024 * 1024).default(''),
  isFolder: z.boolean().default(false),
  isExpanded: z.boolean().default(true),
  orderIdx: z.number().finite().optional(),
  tags: z.array(z.string().min(1).max(100)).max(100).default([]),
}).strict();

export const notePatchRequestSchema = z.object({
  title: z.string().max(500).optional(),
  content: z.string().max(10 * 1024 * 1024).optional(),
  isExpanded: z.boolean().optional(),
  orderIdx: z.number().finite().optional(),
  parentId: uuidSchema.nullable().optional(),
  tags: z.array(z.string().min(1).max(100)).max(100).optional(),
}).strict();

export const searchQuerySchema = z.object({
  q: z.string().trim().max(500).optional(),
}).strict();

export const syncQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  cursor: z.string().max(8192).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

export const backupNoteSchema = z.object({
  id: uuidSchema,
  parentId: uuidSchema.nullable().optional(),
  title: z.string().max(500).optional(),
  content: z.string().max(10 * 1024 * 1024).optional(),
  isFolder: z.boolean().optional(),
  isExpanded: z.boolean().optional(),
  orderIdx: z.number().finite().optional(),
  tags: z.array(z.string().min(1).max(100)).max(100).optional(),
}).passthrough();

export const backupAttachmentSchema = z.object({
  id: uuidSchema,
  noteId: uuidSchema,
  mime: z.enum(ALLOWED_UPLOAD_MIMES),
  name: z.string().max(255).optional(),
  createdAt: z.number().finite().optional(),
  dataBase64: z.string().max(7 * 1024 * 1024).optional(),
}).passthrough();

export const backupPayloadSchema = z.object({
  version: z.literal(2),
  notes: z.array(backupNoteSchema).max(50_000),
  attachments: z.array(backupAttachmentSchema).max(50_000).default([]),
}).strict();
