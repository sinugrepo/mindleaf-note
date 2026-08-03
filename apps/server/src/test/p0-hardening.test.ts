import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app.js';
import { getClientIp } from '../middleware/ratelimit.js';
import { authRoutes } from '../routes/auth.js';

describe('P0 trusted proxy IP extraction', () => {
  it('prefers the proxy-controlled X-Real-IP header', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text(getClientIp(c)));

    const response = await app.request('/', {
      headers: {
        'x-real-ip': '198.51.100.20',
        'x-forwarded-for': '203.0.113.99, 198.51.100.20',
      },
    });

    expect(await response.text()).toBe('198.51.100.20');
  });

  it('uses the final forwarded hop rather than a spoofable first hop', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text(getClientIp(c)));

    const response = await app.request('/', {
      headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.10' },
    });

    expect(await response.text()).toBe('203.0.113.10');
  });
});

describe('P0 CLI-only initial setup', () => {
  it('does not expose an HTTP setup route', () => {
    const app = new Hono();
    app.route('/api/auth', authRoutes);

    expect(app.routes.some((route) => route.path === '/api/auth/setup')).toBe(false);
  });
});

describe('listener-free application integration', () => {
  it('serves health without opening a TCP listener', async () => {
    const response = await createApp().request('/healthz');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('protects a real API route when no session cookie is present', async () => {
    const response = await createApp().request('/api/notes');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('does not expose setup through the full application', () => {
    expect(createApp().routes.some((route) => route.path === '/api/auth/setup')).toBe(false);
  });
});
