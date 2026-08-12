/**
 * Serves the generated OpenAPI 3.1 document for /api/v1.
 *
 * THIS ROUTE IS DELIBERATELY UNAUTHENTICATED. It is public developer
 * documentation: a client needs the spec (and the generated SDK needs it at
 * build time) BEFORE it has a token, and gating it behind a token would make
 * "read the docs" require the very credential the docs explain how to use.
 * The document contains no data — only operation shapes and the scope each
 * operation requires.
 *
 * That is also why this is mounted as a plain `router.get(...)` rather than
 * through the route factory: per-route token/scope gating lives INSIDE the
 * factory, so anything mounted through it is authenticated by construction.
 * Bypassing the factory is the explicit, visible way to opt out — and it is
 * the only route on the v1 surface that does.
 */
import type { RequestHandler } from 'express';

/**
 * Build the spec once on first request, then serve the cached JSON string.
 *
 * Lazy rather than eager so that spec generation happens after every route
 * module has registered, and cached because generation walks every Zod schema
 * on the surface — it is pure, so the result cannot change between requests.
 */
export function createSpecHandler(buildSpec: () => unknown): RequestHandler {
  let cached: string | undefined;

  return (_req, res) => {
    cached ??= JSON.stringify(buildSpec());
    res.type('application/json').send(cached);
  };
}
