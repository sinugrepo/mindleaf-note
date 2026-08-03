import { describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { users, notes, sessions, attachments, tombstones } from '../db/schema.js';
import { db } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.js';
import {
  integrationEnabled,
  storageIntegrationEnabled,
  integrationS3,
  registerIntegrationLifecycle,
} from './integration-helpers.js';

registerIntegrationLifecycle();

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Login response did not set a session cookie');
  return value.split(';', 1)[0];
}

async function login(app: ReturnType<typeof createApp>, password: string): Promise<string> {
  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

async function createNote(
  app: ReturnType<typeof createApp>,
  cookie: string,
  title: string,
): Promise<{ id: string }> {
  const response = await app.request('/api/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { id: string };
}

async function putPresignedObject(
  uploadUrl: string,
  body: Uint8Array,
  mime: string,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': mime },
    body,
  });
  expect(response.ok).toBe(true);
}

describe.runIf(integrationEnabled)('PostgreSQL route integration', () => {
  it('logs in, creates a note, and enforces optimistic locking', async () => {
    const password = 'integration-password';
    await db.insert(users).values({
      passwordHash: await hash(password, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    });
    const app = createApp();

    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toContain('sid=');

    const create = await app.request('/api/notes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookie!.split(';', 1)[0],
      },
      body: JSON.stringify({ title: 'Integration note', content: '<p>secret</p>' }),
    });
    expect(create.status).toBe(201);
    const note = await create.json() as { id: string; version: number };
    expect(note.version).toBe(1);

    const patch = await app.request(`/api/notes/${note.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: cookie!.split(';', 1)[0],
        'if-match': '999',
      },
      body: JSON.stringify({ title: 'stale write' }),
    });
    expect(patch.status).toBe(409);

    const invalidPayload = await app.request('/api/notes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookie!.split(';', 1)[0],
      },
      body: JSON.stringify({ title: 'strict', unexpected: true }),
    });
    expect(invalidPayload.status).toBe(422);
  });

  it('enforces note ownership and hides another user\'s note', async () => {
    const firstPassword = 'first-integration-password';
    const secondPassword = 'second-integration-password';
    const [firstUser] = await db.insert(users).values({
      passwordHash: await hash(firstPassword, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    }).returning({ id: users.id });
    const [secondUser] = await db.insert(users).values({
      passwordHash: await hash(secondPassword, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    }).returning({ id: users.id });
    const privateId = randomUUID();
    await db.insert(notes).values({ id: privateId, userId: secondUser.id, title: 'private' });
    expect(firstUser.id).not.toBe(secondUser.id);

    const app = createApp();
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: firstPassword }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0];
    expect((await app.request(`/api/notes/${privateId}`, { headers: { cookie } })).status).toBe(404);
    const list = await app.request('/api/notes', { headers: { cookie } });
    expect((await list.json() as Array<{ id: string }>).some((note) => note.id === privateId)).toBe(false);
  });

  it('walks all note pages with a stable sync cursor', async () => {
    const password = 'pagination-integration-password';
    await db.insert(users).values({
      passwordHash: await hash(password, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    });
    const app = createApp();
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0];
    for (const title of ['page-a', 'page-b', 'page-c']) {
      expect((await app.request('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ title }),
      })).status).toBe(201);
    }

    const encodeCursor = (cursor: unknown) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
    const ids = new Set<string>();
    let cursor: unknown;
    let hasMore = true;
    while (hasMore) {
      const params = new URLSearchParams({ limit: '1' });
      if (cursor) params.set('cursor', encodeCursor(cursor));
      const response = await app.request(`/api/sync/snapshot?${params}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      const page = await response.json() as {
        notes: Array<{ id: string }>;
        hasMore: boolean;
        nextCursor: unknown;
      };
      page.notes.forEach((note) => ids.add(note.id));
      hasMore = page.hasMore;
      cursor = page.nextCursor;
    }
    expect(ids.size).toBe(3);
  });

  it('rejects expired sessions and rate-limits repeated login attempts', async () => {
    const password = 'expiry-integration-password';
    await db.insert(users).values({
      passwordHash: await hash(password, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    });
    const app = createApp();
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const signedCookie = login.headers.get('set-cookie')!.split(';', 1)[0];
    const sessionId = signedCookie.slice(signedCookie.indexOf('.') + 1);
    await db.update(sessions)
      .set({ expiresAt: new Date(0) })
      .where(eq(sessions.id, sessionId));
    expect((await app.request('/api/notes', { headers: { cookie: signedCookie } })).status).toBe(401);

    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': ip },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      expect(response.status).toBe(401);
    }
    const limited = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(limited.status).toBe(429);
  });

  it('requires recovery when a sync cursor is older than tombstone retention', async () => {
    const previousRetention = process.env.TOMBSTONE_RETENTION_DAYS;
    process.env.TOMBSTONE_RETENTION_DAYS = '90';
    const password = 'retention-integration-password';
    const [user] = await db.insert(users).values({
      passwordHash: await hash(password, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    }).returning({ id: users.id });
    await db.insert(tombstones).values({
      userId: user.id,
      resourceType: 'note',
      resourceId: randomUUID(),
      deletedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
    });
    const app = createApp();
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0];
    const expired = await app.request(
      `/api/sync/snapshot?since=${Date.now() - 91 * 24 * 60 * 60 * 1000}`,
      { headers: { cookie } },
    );
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ recoveryRequired: true });
    if (previousRetention === undefined) delete process.env.TOMBSTONE_RETENTION_DAYS;
    else process.env.TOMBSTONE_RETENTION_DAYS = previousRetention;
  });

  it('walks attachment and tombstone pages without leaking another user\'s rows', async () => {
    const password = 'resource-pagination-integration-password';
    const [user] = await db.insert(users).values({
      passwordHash: await hash(password, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    }).returning({ id: users.id });
    const [otherUser] = await db.insert(users).values({
      passwordHash: await hash('other-resource-password', { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    }).returning({ id: users.id });
    const noteId = randomUUID();
    const otherNoteId = randomUUID();
    await db.insert(notes).values([
      { id: noteId, userId: user.id, title: 'resource owner' },
      { id: otherNoteId, userId: otherUser.id, title: 'private resource owner' },
    ]);
    await db.insert(attachments).values([
      { userId: user.id, noteId, mime: 'image/png', name: 'a.png', sizeBytes: 1 },
      { userId: user.id, noteId, mime: 'image/png', name: 'b.png', sizeBytes: 2 },
      { userId: user.id, noteId, mime: 'image/png', name: 'c.png', sizeBytes: 3 },
      { userId: otherUser.id, noteId: otherNoteId, mime: 'image/png', name: 'private.png', sizeBytes: 4 },
    ]);
    await db.insert(tombstones).values([
      { userId: user.id, resourceType: 'note', resourceId: randomUUID() },
      { userId: user.id, resourceType: 'attachment', resourceId: randomUUID() },
      { userId: user.id, resourceType: 'note', resourceId: randomUUID() },
      { userId: otherUser.id, resourceType: 'note', resourceId: randomUUID() },
    ]);

    const app = createApp();
    const cookie = await login(app, password);
    const seenAttachments = new Set<string>();
    const seenTombstones = new Set<string>();
    let cursor: unknown;
    let hasMore = true;
    while (hasMore) {
      const params = new URLSearchParams({ limit: '1' });
      if (cursor) params.set('cursor', Buffer.from(JSON.stringify(cursor)).toString('base64url'));
      const response = await app.request(`/api/sync/snapshot?${params}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      const page = await response.json() as {
        attachments: Array<{ id: string }>;
        tombstones: Array<{ resourceType: string; resourceId: string }>;
        hasMore: boolean;
        nextCursor: unknown;
      };
      page.attachments.forEach((attachment) => seenAttachments.add(attachment.id));
      page.tombstones.forEach((tombstone) => seenTombstones.add(`${tombstone.resourceType}:${tombstone.resourceId}`));
      hasMore = page.hasMore;
      cursor = page.nextCursor;
    }

    const ownAttachmentRows = await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.userId, user.id));
    const ownTombstoneRows = await db.select({ resourceType: tombstones.resourceType, resourceId: tombstones.resourceId }).from(tombstones).where(eq(tombstones.userId, user.id));
    expect(seenAttachments).toEqual(new Set(ownAttachmentRows.map((row) => row.id)));
    expect(seenTombstones).toEqual(new Set(ownTombstoneRows.map((row) => `${row.resourceType}:${row.resourceId}`)));
    expect([...seenAttachments]).not.toContain((await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.userId, otherUser.id)).limit(1))[0]?.id);
  });

  it('rejects unauthenticated access to notes and sync', async () => {
    const app = createApp();
    expect((await app.request('/api/notes')).status).toBe(401);
    expect((await app.request('/api/sync/snapshot?since=0')).status).toBe(401);
  });
});

describe.runIf(storageIntegrationEnabled)('PostgreSQL and object-storage route integration', () => {
  it('verifies presigned upload completion and syncs authoritative size changes', async () => {
    if (!integrationS3) throw new Error('S3 integration client is not configured');
    const password = 'storage-upload-integration-password';
    await db.insert(users).values({
      passwordHash: await hash(password, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    });
    const app = createApp();
    const cookie = await login(app, password);
    const note = await createNote(app, cookie, 'upload note');
    const presign = await app.request('/api/upload/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        filename: 'pixel.png',
        mime: 'image/png',
        sizeBytes: 4,
        noteId: note.id,
      }),
    });
    expect(presign.status).toBe(200);
    const upload = await presign.json() as { attachmentId: string; uploadUrl: string; r2Key: string };
    const beforeComplete = await app.request('/api/sync/snapshot?limit=10', { headers: { cookie } });
    expect(beforeComplete.status).toBe(200);
    const before = await beforeComplete.json() as { serverNow: number; attachments: Array<{ id: string; sizeBytes: number }> };
    expect(before.attachments.find((attachment) => attachment.id === upload.attachmentId)?.sizeBytes).toBe(4);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await putPresignedObject(upload.uploadUrl, new Uint8Array([137, 80, 78, 71]), 'image/png');
    const complete = await app.request(`/api/upload/attachments/${upload.attachmentId}/complete`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(complete.status).toBe(200);

    const after = await app.request(`/api/sync/snapshot?since=${before.serverNow}&limit=10`, { headers: { cookie } });
    expect(after.status).toBe(200);
    const afterBody = await after.json() as { attachments: Array<{ id: string; sizeBytes: number }> };
    expect(afterBody.attachments.find((attachment) => attachment.id === upload.attachmentId)?.sizeBytes).toBe(4);
    expect(afterBody.attachments.some((attachment) => attachment.id === upload.attachmentId)).toBe(true);

    const download = await app.request(`/api/upload/attachments/${upload.attachmentId}`, { headers: { cookie } });
    expect(download.status).toBe(200);
    const downloadBody = await download.json() as { url: string; r2Key: string; mime: string };
    expect(downloadBody.r2Key).toBe(upload.r2Key);
    expect(downloadBody.mime).toBe('image/png');
    const fetched = await fetch(downloadBody.url);
    expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it('rejects missing, size-mismatched, and MIME-mismatched uploaded objects', async () => {
    const password = 'storage-validation-integration-password';
    await db.insert(users).values({
      passwordHash: await hash(password, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    });
    const app = createApp();
    const cookie = await login(app, password);
    const note = await createNote(app, cookie, 'validation note');

    const missingPresign = await app.request('/api/upload/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ filename: 'missing.png', mime: 'image/png', sizeBytes: 4, noteId: note.id }),
    });
    expect(missingPresign.status).toBe(200);
    const missing = await missingPresign.json() as { attachmentId: string };
    expect((await app.request(`/api/upload/attachments/${missing.attachmentId}/complete`, { method: 'POST', headers: { cookie } })).status).toBe(409);

    const sizePresign = await app.request('/api/upload/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ filename: 'size.png', mime: 'image/png', sizeBytes: 4, noteId: note.id }),
    });
    const size = await sizePresign.json() as { attachmentId: string; uploadUrl: string };
    await putPresignedObject(size.uploadUrl, new Uint8Array([1, 2, 3]), 'image/png');
    expect((await app.request(`/api/upload/attachments/${size.attachmentId}/complete`, { method: 'POST', headers: { cookie } })).status).toBe(409);

    const mimePresign = await app.request('/api/upload/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ filename: 'mime.png', mime: 'image/png', sizeBytes: 4, noteId: note.id }),
    });
    const mime = await mimePresign.json() as { attachmentId: string; uploadUrl: string };
    const wrongMimePut = await fetch(mime.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(wrongMimePut.ok).toBe(false);
    expect((await app.request(`/api/upload/attachments/${mime.attachmentId}/complete`, { method: 'POST', headers: { cookie } })).status).toBe(409);
  });

  it('round-trips backup import, object upload, and export', async () => {
    const password = 'storage-backup-integration-password';
    await db.insert(users).values({
      passwordHash: await hash(password, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    });
    const app = createApp();
    const cookie = await login(app, password);
    const noteId = randomUUID();
    const attachmentId = randomUUID();
    const body = {
      version: 2,
      notes: [{ id: noteId, parentId: null, title: 'backup note', content: '<p>backup content</p>', isFolder: false, isExpanded: true, orderIdx: 1, tags: ['backup'] }],
      attachments: [{ id: attachmentId, noteId, mime: 'image/png', name: 'backup.png', createdAt: Date.now(), dataBase64: Buffer.from([1, 2, 3, 4]).toString('base64') }],
    };
    const form = new FormData();
    form.append('file', new File([JSON.stringify(body)], 'backup.treenote', { type: 'application/json' }));
    const imported = await app.request('/api/backup/import/full', { method: 'POST', headers: { cookie }, body: form });
    expect(imported.status).toBe(200);
    const importBody = await imported.json() as { notesImported: number; attachmentsCreated: number; uploads: Array<{ attachmentId: string; uploadUrl: string; r2Key: string }> };
    expect(importBody.notesImported).toBe(1);
    expect(importBody.attachmentsCreated).toBe(1);
    expect(importBody.uploads).toHaveLength(1);
    await putPresignedObject(importBody.uploads[0].uploadUrl, new Uint8Array([1, 2, 3, 4]), 'image/png');
    const completed = await app.request(`/api/upload/attachments/${attachmentId}/complete`, { method: 'POST', headers: { cookie } });
    expect(completed.status).toBe(200);

    const exported = await app.request('/api/backup/export/full', { method: 'POST', headers: { cookie } });
    expect(exported.status).toBe(200);
    const exportBody = await exported.json() as { version: number; notes: Array<{ id: string; content: string }>; attachments: Array<{ id: string; dataBase64: string }> };
    expect(exportBody.version).toBe(2);
    expect(exportBody.notes.find((note) => note.id === noteId)?.content).toBe('<p>backup content</p>');
    expect(exportBody.attachments.find((attachment) => attachment.id === attachmentId)?.dataBase64).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
  });

  it('isolates backup export and rejects imports that reference another user', async () => {
    const firstPassword = 'backup-owner-integration-password';
    const secondPassword = 'backup-other-integration-password';
    const [firstUser] = await db.insert(users).values({
      passwordHash: await hash(firstPassword, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    }).returning({ id: users.id });
    const [secondUser] = await db.insert(users).values({
      passwordHash: await hash(secondPassword, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    }).returning({ id: users.id });
    const firstNoteId = randomUUID();
    const secondNoteId = randomUUID();
    const secondAttachmentId = randomUUID();
    await db.insert(notes).values([
      { id: firstNoteId, userId: firstUser.id, title: 'first user note' },
      { id: secondNoteId, userId: secondUser.id, title: 'second user private note' },
    ]);
    await db.insert(attachments).values({
      id: secondAttachmentId,
      userId: secondUser.id,
      noteId: secondNoteId,
      r2Key: `private/${secondAttachmentId}.png`,
      mime: 'image/png',
      name: 'private.png',
      sizeBytes: 0,
    });

    const app = createApp();
    const firstCookie = await login(app, firstPassword);
    const exported = await app.request('/api/backup/export/full', {
      method: 'POST',
      headers: { cookie: firstCookie },
    });
    expect(exported.status).toBe(200);
    const exportBody = await exported.json() as {
      notes: Array<{ id: string }>;
      attachments: Array<{ id: string }>;
    };
    expect(exportBody.notes.map((note) => note.id)).toEqual([firstNoteId]);
    expect(exportBody.attachments).toEqual([]);

    const foreignReference = {
      version: 2,
      notes: [],
      attachments: [{
        id: randomUUID(),
        noteId: secondNoteId,
        mime: 'image/png',
        name: 'foreign.png',
        createdAt: Date.now(),
        dataBase64: '',
      }],
    };
    const form = new FormData();
    form.append('file', new File([JSON.stringify(foreignReference)], 'foreign.treenote', { type: 'application/json' }));
    const imported = await app.request('/api/backup/import/full', {
      method: 'POST',
      headers: { cookie: firstCookie },
      body: form,
    });
    expect(imported.status).toBe(409);
    expect(firstUser.id).not.toBe(secondUser.id);

    const malformed = {
      version: 2,
      notes: [{ id: firstNoteId, parentId: null, title: 'must not import', content: 'x' }],
      attachments: [{
        id: randomUUID(),
        noteId: firstNoteId,
        mime: 'image/png',
        name: 'broken.png',
        createdAt: Date.now(),
        dataBase64: 'not-base64',
      }],
    };
    const malformedForm = new FormData();
    malformedForm.append('file', new File([JSON.stringify(malformed)], 'malformed.treenote', { type: 'application/json' }));
    const malformedImport = await app.request('/api/backup/import/full', {
      method: 'POST',
      headers: { cookie: firstCookie },
      body: malformedForm,
    });
    expect(malformedImport.status).toBe(400);
    const existing = await db.select({ title: notes.title }).from(notes).where(eq(notes.id, firstNoteId));
    expect(existing[0]?.title).toBe('first user note');
  });

  it('does not expose another user\'s attachment through upload routes', async () => {
    const password = 'storage-owner-integration-password';
    const [firstUser] = await db.insert(users).values({
      passwordHash: await hash(password, { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    }).returning({ id: users.id });
    const [secondUser] = await db.insert(users).values({
      passwordHash: await hash('storage-other-password', { algorithm: 2, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
    }).returning({ id: users.id });
    const noteId = randomUUID();
    const attachmentId = randomUUID();
    await db.insert(notes).values({ id: noteId, userId: secondUser.id, title: 'private' });
    await db.insert(attachments).values({ id: attachmentId, userId: secondUser.id, noteId, r2Key: `private/${attachmentId}.png`, mime: 'image/png', name: 'private.png', sizeBytes: 4 });
    const app = createApp();
    const cookie = await login(app, password);
    expect((await app.request(`/api/upload/attachments/${attachmentId}`, { headers: { cookie } })).status).toBe(404);
    expect((await app.request(`/api/upload/attachments/${attachmentId}/complete`, { method: 'POST', headers: { cookie } })).status).toBe(404);
    expect(firstUser.id).not.toBe(secondUser.id);
  });
});
