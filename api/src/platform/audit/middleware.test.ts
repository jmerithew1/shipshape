/**
 * Public audit trail — exercised end to end against the real `ship_test`
 * database, through a real v1 router, because the properties that matter
 * (correct status, correct correlation id, no impact on the response) are
 * properties of the WIRING, not of a function.
 *
 * Cleanup is a per-run workspace deleted with CASCADE; nothing here truncates.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { pool } from '../../db/client.js';
import { createV1Router } from '../api/v1/router.js';
import { registerV1Routes } from '../api/v1/resources/routes.js';
import { auditTrail, auditEnabled, resolveRoutePattern, scopeFromCatalog } from './middleware.js';

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let workspaceId: string;
let userId: string;
let appId: string;
const CLIENT_ID = `ship_client_audit_${runId}`;

/** Stand-in for tokenGate — sets exactly what the recorder reads. */
function fakePlatform(overrides: Partial<NonNullable<Request['platform']>> = {}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.platform = {
      tokenId: 'token-1',
      userId,
      workspaceId,
      isSuperAdmin: false,
      clientId: CLIENT_ID,
      oauthAppId: appId,
      grantedScopes: ['documents:read'],
      ...overrides,
    };
    next();
  };
}

interface AuditRow {
  request_id: string;
  app_id: string | null;
  client_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  method: string;
  route: string;
  scope_used: string | null;
  status: number;
  latency_ms: number;
}

/** The write is fire-and-forget, so the assertion polls for it. */
async function waitForAuditRow(requestId: string, tries = 60): Promise<AuditRow> {
  for (let i = 0; i < tries; i++) {
    const { rows } = await pool.query<AuditRow>(
      `SELECT * FROM public_audit_log WHERE request_id = $1`,
      [requestId]
    );
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no audit row appeared for request ${requestId}`);
}

describe('auditTrail', () => {
  beforeAll(async () => {
    // Populating the real route catalog makes scope_used resolution the
    // production one rather than a stub.
    registerV1Routes(Router());

    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`Audit Trail ${runId}`]
    );
    workspaceId = ws.rows[0]!.id;

    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'x', 'Audit Trail Test') RETURNING id`,
      [`audit-${runId}@ship.local`]
    );
    userId = user.rows[0]!.id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId]
    );

    const app = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps
         (workspace_id, owner_user_id, name, client_id, client_secret_hash,
          client_secret_prefix, redirect_uris, requested_scopes)
       VALUES ($1, $2, $3, $4, 'hash', 'prefix12', ARRAY['https://x.example/cb'],
               ARRAY['documents:read'])
       RETURNING id`,
      [workspaceId, userId, `Audit App ${runId}`, CLIENT_ID]
    );
    appId = app.rows[0]!.id;
  });

  afterAll(async () => {
    // CASCADE from workspaces reaches oauth_apps and public_audit_log.
    if (workspaceId) await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    if (userId) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  function buildApp(register: (router: Router) => void) {
    const app = express();
    app.use(
      '/api/v1',
      createV1Router((router) => {
        router.use(auditTrail({ enabled: true }));
        register(router);
      })
    );
    return app;
  }

  it('records one row per request, with the mounted route pattern and the declared scope', async () => {
    const app = buildApp((router) => {
      router.get('/documents/:id', fakePlatform(), (_req, res) => {
        res.json({ id: 'doc-1' });
      });
    });

    const res = await request(app).get('/api/v1/documents/0f9c5a2e-1111-2222-3333-444455556666');
    expect(res.status).toBe(200);

    const row = await waitForAuditRow(res.headers['x-request-id']!);
    expect(row).toMatchObject({
      app_id: appId,
      client_id: CLIENT_ID,
      user_id: userId,
      workspace_id: workspaceId,
      method: 'GET',
      // The PATTERN, never the id-bearing URL.
      route: '/api/v1/documents/:id',
      scope_used: 'documents:read',
      status: 200,
    });
    expect(row.route).not.toContain('0f9c5a2e');
    expect(Number.isInteger(row.latency_ms)).toBe(true);
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('ties the row to the response via X-Request-Id', async () => {
    const app = buildApp((router) => {
      router.get('/me', fakePlatform(), (_req, res) => {
        res.json({ ok: true });
      });
    });

    const res = await request(app).get('/api/v1/me');
    const requestId = res.headers['x-request-id'];
    expect(requestId).toBeTruthy();

    const row = await waitForAuditRow(requestId!);
    expect(row.request_id).toBe(requestId);
  });

  it('records the REAL status, including failures, because it runs on finish', async () => {
    const app = buildApp((router) => {
      router.get('/me', fakePlatform(), (_req, _res, next) => {
        next(new Error('boom'));
      });
    });

    const res = await request(app).get('/api/v1/me');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('server_error');

    const row = await waitForAuditRow(res.headers['x-request-id']!);
    expect(row.status).toBe(500);
    expect(row.route).toBe('/api/v1/me');
  });

  it('records unauthenticated requests with null identity columns', async () => {
    const app = buildApp((router) => {
      // No fakePlatform: nothing set req.platform, as if tokenGate rejected.
      router.get('/anon', (_req, res) => {
        res.status(401).json({ code: 'unauthorized' });
      });
    });

    const res = await request(app).get('/api/v1/anon');
    const row = await waitForAuditRow(res.headers['x-request-id']!);
    expect(row).toMatchObject({
      app_id: null,
      client_id: null,
      user_id: null,
      workspace_id: null,
      status: 401,
      route: '/api/v1/anon',
      scope_used: null,
    });
  });

  it('never records a raw URL for an unmatched path', async () => {
    const app = buildApp(() => {
      /* no routes at all — everything hits the v1 404 */
    });

    const res = await request(app).get('/api/v1/documents/secret-id-9999');
    expect(res.status).toBe(404);

    // Unmatched: workspace_id is null, so poll by request id across the table.
    const row = await waitForAuditRow(res.headers['x-request-id']!);
    expect(row.route).toBe('/api/v1/*');
    expect(row.route).not.toContain('secret-id-9999');
    await pool.query(`DELETE FROM public_audit_log WHERE request_id = $1`, [row.request_id]);
  });

  it('does not fail the request when the audit write throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.use(
      '/api/v1',
      createV1Router((router) => {
        router.use(
          auditTrail({ enabled: true, query: () => Promise.reject(new Error('db is on fire')) })
        );
        router.get('/me', fakePlatform(), (_req, res) => {
          res.json({ ok: true });
        });
      })
    );

    const res = await request(app).get('/api/v1/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // The failure is logged, loudly, and goes no further.
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('audit write failed'),
        expect.any(Error)
      );
    });
    errorSpy.mockRestore();
  });

  it('issues ZERO queries when the kill switch is off', async () => {
    const query = vi.fn(() => Promise.resolve());
    const app = express();
    app.use(
      '/api/v1',
      createV1Router((router) => {
        router.use(auditTrail({ enabled: false, query }));
        router.get('/me', fakePlatform(), (_req, res) => {
          res.json({ ok: true });
        });
      })
    );

    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/v1/me')).status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(query).not.toHaveBeenCalled();
  });

  it('honours AUDIT_ENABLED=false from the environment', async () => {
    const query = vi.fn(() => Promise.resolve());
    const app = express();
    app.use(
      '/api/v1',
      createV1Router((router) => {
        router.use(auditTrail({ env: { AUDIT_ENABLED: 'false' }, query }));
        router.get('/me', fakePlatform(), (_req, res) => {
          res.json({ ok: true });
        });
      })
    );

    await request(app).get('/api/v1/me');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(query).not.toHaveBeenCalled();
  });
});

describe('audit kill switch', () => {
  it('defaults off under NODE_ENV=test and on elsewhere; env always wins', () => {
    expect(auditEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(auditEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(auditEnabled({})).toBe(true);
    expect(auditEnabled({ NODE_ENV: 'test', AUDIT_ENABLED: 'true' })).toBe(true);
    expect(auditEnabled({ NODE_ENV: 'production', AUDIT_ENABLED: 'false' })).toBe(false);
  });
});

describe('route pattern resolution', () => {
  const withRoute = (path: string | undefined) => ({ route: path === undefined ? undefined : { path } }) as unknown as Request;

  it('joins the mount path to the matched route pattern', () => {
    expect(resolveRoutePattern(withRoute('/documents/:id'), '/api/v1')).toBe('/api/v1/documents/:id');
    expect(resolveRoutePattern(withRoute('/'), '/api/v1')).toBe('/api/v1');
    expect(resolveRoutePattern(withRoute('/me'), '')).toBe('/me');
  });

  it('degrades to a wildcard rather than logging an id-bearing URL', () => {
    expect(resolveRoutePattern(withRoute(undefined), '/api/v1')).toBe('/api/v1/*');
  });
});

describe('scopeFromCatalog', () => {
  it('reads the scope each route DECLARED, so it cannot drift from requireScope', () => {
    registerV1Routes(Router());
    expect(scopeFromCatalog('GET', '/documents/:id')).toBe('documents:read');
    expect(scopeFromCatalog('POST', '/documents')).toBe('documents:write');
    expect(scopeFromCatalog('GET', '/nope')).toBeNull();
  });
});
