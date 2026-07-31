/**
 * Lightweight fetch-based API client for the Mindleaf backend.
 *
 * All requests go through the Vite dev proxy (`/api` → `:8787`) in dev,
 * or Caddy reverse-proxy in prod. HttpOnly session cookies are sent
 * automatically by the browser — no manual cookie management needed.
 *
 * We intentionally avoid Hono RPC (`hc<>`) for now: it requires importing
 * the server's `App` type, which couples frontend builds to backend
 * output. The shared DTO types in `@mindleaf/shared` are enough for
 * type safety on the response payloads.
 */

import type {
  NoteDTO,
  SyncSnapshot,
  PresignRequest,
  PresignResponse,
  AttachmentUrlResponse,
  LoginRequest,
  ApiErrorResponse,
  BackupPayloadV2,
  BackupImportResponse,
} from '@mindleaf/shared';

const API_BASE = '/api';

/** True when the backend is reachable and we have a session cookie. */
let _hasSession = false;

export function setHasSession(v: boolean): void {
  _hasSession = v;
}

export function hasSession(): boolean {
  return _hasSession;
}

/**
 * Check whether the sync engine should be active. Returns true only
 * when the user has a session cookie (logged in to the backend).
 * When false, the app operates in pure local mode — no sync, no
 * queue draining. Mutations are still enqueued so they can be
 * pushed after login.
 *
 * Lives here (not in sync/queue.ts) to avoid a circular import:
 * queue.ts → drainer.ts → queue.ts (via shouldSync).
 */
export function shouldSync(): boolean {
  return _hasSession;
}

/**
 * Low-level fetch wrapper. Throws on non-2xx, returns parsed JSON.
 * The error includes the `ApiErrorResponse` body when the server
 * provides one (e.g. 409 Conflict with a `remote` note).
 *
 * Content-Type handling: defaults to `application/json` when no
 * body is given OR when the caller wants JSON. Skipped when the
 * caller passes a `FormData` body — the browser must own the
 * Content-Type so it can compute the multipart boundary (any
 * caller-set `Content-Type: application/json` on a multipart body
 * would silently strip the boundary and the server would fail to
 * parse it). Callers must explicitly set `Content-Type: '...'`
 * for any other custom body type.
 */
async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const baseHeaders: Record<string, string> = isFormData
    ? /* let the browser fill multipart with boundary */
      { ...(init?.headers as Record<string, string> | undefined) }
    : {
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      };
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: baseHeaders,
  });

  if (!res.ok) {
    // Detect session expiry — set _hasSession = false so the sync
    // engine stops retrying uselessly. The user will need to log in
    // again (the UI can show a login prompt when hasSession() is false).
    if (res.status === 401) {
      setHasSession(false);
    }
    let errBody: ApiErrorResponse | null = null;
    try {
      errBody = (await res.json()) as ApiErrorResponse;
    } catch {
      // Non-JSON error body (e.g. 502 from Caddy) — use status text.
    }
    const err = new Error(
      errBody?.error ?? res.statusText ?? `HTTP ${res.status}`,
    ) as Error & { status: number; body?: ApiErrorResponse };
    err.status = res.status;
    if (errBody) err.body = errBody;
    throw err;
  }

  return res.json() as Promise<T>;
}

// --- Auth ---

export const api = {
  async login(body: LoginRequest): Promise<{ ok: true }> {
    const result = await apiFetch<{ ok: true }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setHasSession(true);
    return result;
  },

  async logout(): Promise<void> {
    try {
      await apiFetch<{ ok: true }>('/auth/logout', { method: 'POST' });
    } finally {
      setHasSession(false);
    }
  },

  async setup(password: string): Promise<{ ok: true }> {
    const result = await apiFetch<{ ok: true }>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    return result;
  },

  async getMeInfo(): Promise<{ createdAt: number; noteCount: number }> {
    return apiFetch('/me/info');
  },

  // --- Notes ---

  async getNotes(): Promise<NoteDTO[]> {
    return apiFetch('/notes');
  },

  async getNote(id: string): Promise<NoteDTO> {
    return apiFetch(`/notes/${id}`);
  },

  async createNote(body: {
    id?: string;
    parentId?: string | null;
    title?: string;
    isFolder?: boolean;
    content?: string;
    tags?: string[];
    orderIdx?: number;
  }): Promise<NoteDTO> {
    return apiFetch('/notes', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  async patchNote(
    id: string,
    body: {
      title?: string;
      content?: string;
      isExpanded?: boolean;
      orderIdx?: number;
      parentId?: string | null;
      tags?: string[];
    },
    ifMatch?: number,
  ): Promise<NoteDTO> {
    const headers: Record<string, string> = {};
    if (ifMatch !== undefined && ifMatch !== null) {
      headers['If-Match'] = String(ifMatch);
    }
    return apiFetch(`/notes/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
  },

  async deleteNote(id: string): Promise<{ ok: true; deleted: number }> {
    return apiFetch(`/notes/${id}`, { method: 'DELETE' });
  },

  async restoreNote(id: string): Promise<{ ok: true; restored: number }> {
    return apiFetch(`/notes/${id}/restore`, { method: 'POST' });
  },

  async permanentDeleteNote(
    id: string,
  ): Promise<{ ok: true; deleted: number }> {
    return apiFetch(`/notes/${id}/permanent`, { method: 'POST' });
  },

  // --- Upload ---

  async presignUpload(
    body: PresignRequest,
  ): Promise<PresignResponse> {
    return apiFetch('/upload/presign', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  async completeUpload(attachmentId: string): Promise<{ ok: true }> {
    return apiFetch(`/upload/attachments/${attachmentId}/complete`, {
      method: 'POST',
    });
  },

  async getAttachmentUrl(
    attachmentId: string,
  ): Promise<AttachmentUrlResponse> {
    return apiFetch(`/upload/attachments/${attachmentId}`);
  },

  // --- Sync ---

  async getSyncSnapshot(sinceMs: number): Promise<SyncSnapshot> {
    const qs = sinceMs > 0 ? `?since=${sinceMs}` : '';
    return apiFetch(`/sync/snapshot${qs}`);
  },

  // --- Search ---

  async searchNotes(q: string): Promise<NoteDTO[]> {
    return apiFetch(`/search?q=${encodeURIComponent(q)}`);
  },

  // --- Backup (Phase 7) ---

  /**
   * Phase 7 — cloud export. Returns a fully-hydrated `BackupPayloadV2`
   * (notes decrypted server-side, attachments inlined as base64).
   * Caller is expected to serialize to a `.treenote` file download —
   * we keep the wire format identical to the local-cache export so
   * either path is interchangeable.
   *
   * Falls back to the local-cache export (handled at the Sidebar
   * layer) when the API is unreachable.
   */
  async exportFull(): Promise<BackupPayloadV2> {
    return apiFetch('/backup/export/full', { method: 'POST' });
  },

  /**
   * Phase 7 — cloud import. Submits a `.treenote` file as multipart
   * form-data to the backend. Server re-encrypts notes with the
   * master key, creates attachment rows, and returns presigned PUT
   * URLs so the frontend can upload each blob directly to R2 (the
   * VPS never proxies attachment bytes).
   *
   * Caller (Sidebar) handles the PUT-to-R2 leg with `presignedPut`
   * uploads in parallel and triggers a full pull after success so
   * the local cache picks up the new notes.
   */
  async importFull(file: File): Promise<BackupImportResponse> {
    const fd = new FormData();
    fd.append('file', file);
    return apiFetch('/backup/import/full', {
      method: 'POST',
      body: fd,
      // Do NOT set Content-Type — browser auto-fills the boundary.
      headers: {},
    });
  },
};
