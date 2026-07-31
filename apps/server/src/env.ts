/**
 * Hono environment type. Declares the context variables that
 * middleware sets and route handlers read. This gives us type-safe
 * `c.get('userId')` and `c.set('userId', ...)` across all routes.
 *
 * Extracted to its own file (rather than living in `index.ts`) to
 * avoid a circular type dependency: every route file imports
 * `AppEnv`, and `index.ts` imports every route file.
 */
export type AppEnv = {
  Variables: {
    userId: string;
  };
};
