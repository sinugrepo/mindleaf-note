import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
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
