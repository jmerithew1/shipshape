/**
 * auditTrail() — the public API's audit trail (Week 6 brief, "Public Audit
 * Trail"). Every /api/v1 request becomes exactly one `public_audit_log` row.
 *
 * THREE PROPERTIES, ALL DELIBERATE:
 *
 * 1. IT RECORDS ON `finish`, NOT ON ENTRY. Writing at entry would have to
 *    guess the status and could never know the latency. Hooking `res.on(
 *    'finish')` captures the REAL outcome — including 401s from tokenGate,
 *    429s from the limiter, and 500s from the error handler — because those
 *    all still finish a response. The listener runs after the bytes are on the
 *    wire, so the audit write is never in the client's critical path.
 *
 * 2. IT NEVER FAILS A REQUEST. The insert is fire-and-forget and its errors
 *    are swallowed to a log line. An audit trail that can 500 the API it
 *    audits is a liability; the correct failure mode for observability is to
 *    lose the record, loudly, and serve the request.
 *
 * 3. IT LOGS ROUTE PATTERNS, NOT URLS. `/api/v1/documents/:id`, never
 *    `/api/v1/documents/9f3c...`. Resource ids in an audit route column are
 *    unaggregatable (every row unique) and quietly turn the log into a second
 *    copy of the data it is meant to describe.
 *
 * KILL SWITCH FIRST. `AUDIT_ENABLED` is checked BEFORE anything else and
 * before any query — the same discipline as FLEETGRAPH_ENABLED in
 * utils/document-crud.ts. Several route suites mock `pool.query` with strict
 * call sequences; an unguarded background write consumes their mocked
 * responses and breaks tests that have nothing to do with auditing. Default:
 * on everywhere except NODE_ENV=test, where a suite opts in explicitly.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { pool } from '../../db/client.js';
import { v1RouteCatalog } from '../openapi/v1-registry.js';

/** Minimal shape of the query runner, so tests can inject a spy. */
export type AuditQueryRunner = (text: string, params: unknown[]) => Promise<unknown>;

export interface AuditTrailOptions {
  /** Overrides the env kill switch entirely. */
  enabled?: boolean;
  /** Env source, injected for tests. */
  env?: NodeJS.ProcessEnv;
  /** Database seam. Defaults to the shared pool. */
  query?: AuditQueryRunner;
  /**
   * Maps (method, route pattern) -> the scope the route declared. Defaults to
   * the v1 route catalog, so `scope_used` is derived from the same source of
   * truth as the OpenAPI spec and can never drift from what requireScope
   * actually enforced.
   */
  scopeFor?: (method: string, routePattern: string) => string | null;
}

export function auditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AUDIT_ENABLED !== undefined) return env.AUDIT_ENABLED !== 'false';
  return env.NODE_ENV !== 'test';
}

/**
 * The route pattern as MOUNTED: the router's mount path plus the matched
 * route's declared path. `mountPath` is captured on the way in because Express
 * restores `req.baseUrl` as the dispatch stack unwinds, and `finish` fires
 * after that.
 */
export function resolveRoutePattern(req: Request, mountPath: string): string {
  const route = (req as Request & { route?: { path?: unknown } }).route;
  const pattern = typeof route?.path === 'string' ? route.path : null;
  // No route matched (404, or a failure before dispatch). There is no pattern
  // to report and the raw path may carry ids, so record the mount and stop.
  if (pattern === null) return `${mountPath}/*`;
  if (pattern === '/' || pattern === '') return mountPath || '/';
  return `${mountPath}${pattern}`;
}

/** Catalog-backed scope lookup — see `scopeFor` above. */
export function scopeFromCatalog(method: string, routePattern: string): string | null {
  const m = method.toLowerCase();
  const found = v1RouteCatalog.find((r) => r.method === m && r.path === routePattern);
  return found?.scope ?? null;
}

/**
 * uuid columns reject '' and non-uuid junk. The audit row must be insertable
 * for anonymous and failed requests too, so anything that is not a plausible
 * id becomes NULL rather than a constraint violation that loses the row.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

const INSERT_SQL = `INSERT INTO public_audit_log
       (request_id, app_id, client_id, user_id, workspace_id,
        method, route, scope_used, status, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

export function auditTrail(options: AuditTrailOptions = {}): RequestHandler {
  const runQuery: AuditQueryRunner =
    options.query ?? ((text, params) => pool.query(text, params));
  const scopeFor = options.scopeFor ?? scopeFromCatalog;

  return function auditTrailRecorder(req: Request, res: Response, next: NextFunction): void {
    // Kill switch BEFORE any work at all — no listener, no clock, no query.
    const enabled = options.enabled ?? auditEnabled(options.env ?? process.env);
    if (!enabled) {
      next();
      return;
    }

    // Captured now: `req.baseUrl` is not stable at finish time (see above).
    const mountPath = req.baseUrl || '';
    const startedAtNs = process.hrtime.bigint();

    res.on('finish', () => {
      const latencyMs = Math.max(0, Number((process.hrtime.bigint() - startedAtNs) / 1_000_000n));
      const route = resolveRoutePattern(req, mountPath);
      const ctx = req.platform;

      const params: unknown[] = [
        req.requestId ?? 'missing-request-id',
        uuidOrNull(ctx?.oauthAppId),
        ctx?.clientId ?? null,
        uuidOrNull(ctx?.userId),
        uuidOrNull(ctx?.workspaceId),
        req.method,
        route,
        scopeFor(req.method, route.slice(mountPath.length) || '/'),
        res.statusCode,
        latencyMs,
      ];

      // Fire-and-forget: no await, no rejection escaping, no effect on the
      // response (which has already been sent).
      void Promise.resolve()
        .then(() => runQuery(INSERT_SQL, params))
        .catch((err: unknown) => {
          console.error(`[api/v1] audit write failed (request ${req.requestId}):`, err);
        });
    });

    next();
  };
}
