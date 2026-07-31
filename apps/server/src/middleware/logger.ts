import pino from 'pino';
import type { MiddlewareHandler } from 'hono';
import { randomUUID } from 'node:crypto';
import type { AppEnv } from '../env.js';

/**
 * Phase 10 — Structured JSON access logging via Pino.
 *
 * Replaces hono/logger (plain Console.log) because:
 *   1. Production needs structured JSON for `journalctl | jq` queries
 *      and any future log shippers (Loki, OTel, etc.) without further
 *      glue code.
 *   2. Pino redacts sensitive headers automatically — cookie +
 *      authorization headers never touch stdout.
 *   3. Pino-pretty is bundled in dev mode so the developer sees
 *      colorized, readable logs without changing call sites.
 *
 * Usage in index.ts:
 *   import { pinoLogger } from './middleware/logger.js';
 *   app.use('*', pinoLogger());
 *
 * Each request is tagged with a `requestId` (UUIDv4 if the client
 * doesn't supply one) and logged once with method, path, status,
 * duration (ms), userId (if session middleware ran), and the IP from
 * `X-Forwarded-For` (set by Caddy) so audit trails survive the proxy.
 */

// Single pino instance — created once for the process lifetime so the
// child-logger stream stays open and stdout buffers aren't reinitialized.
const isProd = process.env.NODE_ENV === 'production';
const logLevel =
  process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug');

export const baseLogger = pino({
  level: logLevel,
  // Redaction paths: things that NEVER make it to stdout even at
  // debug level. We use Pino's bracket notation for safety.
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      '*.sessionId',
      '*.password',
      '*.passwordHash',
    ],
    censor: '[REDACTED]',
  },
  // Production: one JSON line per log record. Boss-friendly for
  // journald's structured indexer and downstream jq queries.
  // Development: pretty-print so the terminal doesn't look like a
  // SQL dump. The transport is lazy-loaded so prod doesn't ship
  // pino-pretty into the bundle (avoids the worker-thread startup
  // cost on cold starts).
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,requestId',
        },
      },
  // Omit pid + hostname in dev-only (they make pretty output noisy)
  // but include them in prod for distributed tracing across
  // multiple-mindleaf VPS replicas (future-proofing).
  base: isProd ? undefined : { pid: undefined },
});

/**
 * Compose a request-id: prefer the upstream `X-Request-Id` (Caddy
 * or app-level fetch wrapper), fall back to a UUIDv4.
 */
function requestIdFor(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('x-request-id') ?? randomUUID();
}

/**
 * Hono middleware: lets each `next()` call wrap a child logger that
 * carries `requestId` + `userId`, then emits one info-level access
 * record with method/path/status/duration.
 */
export const pinoLogger = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const requestId = requestIdFor(c);
    const child = baseLogger.child({ requestId });

    const start = process.hrtime.bigint();
    let status = 500;
    try {
      await next();
      // After `next`, Hono has finalized the response; status is
      // authoritative.
      status = c.res.status;
    } finally {
      const durationMs = Number((process.hrtime.bigint() - start)) / 1e6;

      // Pull userId if session middleware ran ahead of us. Stored
      // in c.set('userId', ...) — typed via AppEnv.Variables but we
      // read defensively because pinoLogger is mounted first.
      const userId = (c.get as (k: string) => unknown)('userId');
      const xff = c.req.header('x-forwarded-for');
      const ip = xff ? xff.split(',')[0]?.trim() : undefined;

      child.info(
        {
          method: c.req.method,
          path: c.req.path,
          status,
          durationMs: Math.round(durationMs * 100) / 100,
          ...(userId ? { userId } : {}),
          ...(ip ? { ip } : {}),
        },
        'http_access',
      );
    }
  };
};
