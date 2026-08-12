/**
 * The portal's audit-log endpoint. Auth is injected, so these tests exercise
 * the routing and the workspace scoping without standing up a session.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import request from 'supertest';
import { pool } from '../../db/client.js';
import { createAuditRouter } from './routes.js';

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let workspaceId: string;
let otherWorkspaceId: string;
let userId: string;

const CLIENT_ID = `client_routes_${runId}`;

async function seed(workspace: string, clientId: string, seconds: number) {
  await pool.query(
    `INSERT INTO public_audit_log
       (request_id, occurred_at, client_id, user_id, workspace_id,
        method, route, scope_used, status, latency_ms)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'GET', '/api/v1/documents',
             'documents:read', 200, 5)`,
    [new Date(Date.UTC(2026, 1, 1, 0, 0, seconds)).toISOString(), clientId, userId, workspace]
  );
}

/** Session stand-in — the real router gets authMiddleware injected instead. */
function buildApp(workspace: string | undefined) {
  const auth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    req.workspaceId = workspace as string;
    next();
  };
  const app = express();
  app.use('/api/devportal', createAuditRouter({ auth }));
  return app;
}

describe('createAuditRouter', () => {
  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`Audit Routes ${runId}`]
    );
    workspaceId = ws.rows[0]!.id;

    const other = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`Audit Routes Other ${runId}`]
    );
    otherWorkspaceId = other.rows[0]!.id;

    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'x', 'Audit Routes Test') RETURNING id`,
      [`audit-routes-${runId}@ship.local`]
    );
    userId = user.rows[0]!.id;

    for (let i = 0; i < 3; i++) await seed(workspaceId, CLIENT_ID, i);
    await seed(workspaceId, 'some_other_client', 9);
    await seed(otherWorkspaceId, CLIENT_ID, 5);
  });

  afterAll(async () => {
    for (const id of [workspaceId, otherWorkspaceId]) {
      if (id) await pool.query(`DELETE FROM workspaces WHERE id = $1`, [id]);
    }
    if (userId) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it('returns the session workspace’s entries, never another workspace’s', async () => {
    const res = await request(buildApp(workspaceId)).get('/api/devportal/audit-log');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.logs).toHaveLength(4);
    expect(
      res.body.data.logs.every((row: { workspace_id: string }) => row.workspace_id === workspaceId)
    ).toBe(true);
  });

  it('filters by client_id and paginates with an opaque cursor', async () => {
    const app = buildApp(workspaceId);

    const filtered = await request(app)
      .get('/api/devportal/audit-log')
      .query({ client_id: CLIENT_ID });
    expect(filtered.body.data.logs).toHaveLength(3);

    const firstPage = await request(app)
      .get('/api/devportal/audit-log')
      .query({ client_id: CLIENT_ID, limit: 2 });
    expect(firstPage.body.data.logs).toHaveLength(2);
    expect(firstPage.body.data.next_cursor).toBeTruthy();

    const secondPage = await request(app)
      .get('/api/devportal/audit-log')
      .query({ client_id: CLIENT_ID, limit: 2, cursor: firstPage.body.data.next_cursor });
    expect(secondPage.body.data.logs).toHaveLength(1);
    expect(secondPage.body.data.next_cursor).toBeNull();
  });

  it('refuses to read anything when the session names no workspace', async () => {
    const res = await request(buildApp(undefined)).get('/api/devportal/audit-log');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
