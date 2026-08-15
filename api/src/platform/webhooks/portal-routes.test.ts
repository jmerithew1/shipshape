/**
 * The portal's session-authed webhook alias. Auth is injected, so these tests
 * exercise routing and — the part that matters — the tenancy check, without
 * standing up a session.
 *
 * The cross-tenant case is the reason this file exists. `app_id` arrives from
 * the client, so without an ownership check against the SESSION's workspace a
 * signed-in user could read or delete another workspace's subscriptions by
 * guessing an id. That defect was found and fixed once already on the v1 side;
 * an alias that forgot it would reintroduce it behind a different URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import request from 'supertest';
import { pool } from '../../db/client.js';
import { createPortalWebhookRouter } from './portal-routes.js';

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let workspaceId: string;
let otherWorkspaceId: string;
let appId: string;
let otherAppId: string;

async function makeWorkspace(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [name]
  );
  return r.rows[0]!.id;
}

async function makeApp(workspace: string, suffix: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO oauth_apps
       (workspace_id, name, client_id, client_secret_hash, client_secret_prefix,
        redirect_uris, requested_scopes)
     VALUES ($1, $2, $3, 'x', 'xxxxxxxx', ARRAY['https://example.com/cb'],
             ARRAY['webhooks:manage'])
     RETURNING id`,
    [workspace, `Portal Alias ${suffix}`, `client_portal_${suffix}`]
  );
  return r.rows[0]!.id;
}

/** Session stand-in — the real router gets authMiddleware injected instead. */
function buildApp(workspace: string | undefined) {
  const auth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    req.workspaceId = workspace as string;
    next();
  };
  const app = express();
  app.use(express.json());
  app.use('/api/devportal', createPortalWebhookRouter({ auth }));
  return app;
}

describe('createPortalWebhookRouter', () => {
  beforeAll(async () => {
    workspaceId = await makeWorkspace(`Portal Alias ${runId}`);
    otherWorkspaceId = await makeWorkspace(`Portal Alias Other ${runId}`);
    appId = await makeApp(workspaceId, `a${runId}`);
    otherAppId = await makeApp(otherWorkspaceId, `b${runId}`);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = ANY($1::uuid[])', [[appId, otherAppId]]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [
      [workspaceId, otherWorkspaceId],
    ]);
  });

  it('lists subscriptions for an app in the session workspace', async () => {
    const res = await request(buildApp(workspaceId)).get(`/api/devportal/webhooks?app_id=${appId}`);
    expect(res.status).toBe(200);
    // Same envelope as the v1 handler — that sameness is what let the portal
    // switch surfaces by changing one constant.
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('next_cursor', null);
  });

  it('creates a subscription and returns the raw secret exactly once', async () => {
    const res = await request(buildApp(workspaceId))
      .post('/api/devportal/webhooks')
      .send({ app_id: appId, event_type: 'document.created', target_url: 'https://example.com/hook' });
    expect(res.status).toBe(201);
    expect(res.body.signing_secret).toMatch(/^ship_whsec_/);
    expect(res.headers['cache-control']).toBe('no-store');

    // ...and never again on a subsequent read.
    const list = await request(buildApp(workspaceId)).get(`/api/devportal/webhooks?app_id=${appId}`);
    expect(JSON.stringify(list.body)).not.toContain(res.body.signing_secret);
  });

  it('refuses an app_id from another workspace (cross-tenant)', async () => {
    const res = await request(buildApp(workspaceId)).get(
      `/api/devportal/webhooks?app_id=${otherAppId}`
    );
    // 404, not 403: a distinct 403 would confirm the id is real.
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('refuses to delete a subscription via an app_id from another workspace', async () => {
    const res = await request(buildApp(workspaceId)).delete(
      `/api/devportal/webhooks/00000000-0000-0000-0000-000000000000?app_id=${otherAppId}`
    );
    expect(res.status).toBe(404);
  });

  it('requires app_id, and a selected workspace', async () => {
    const noApp = await request(buildApp(workspaceId)).get('/api/devportal/webhooks');
    expect(noApp.status).toBe(400);
    expect(noApp.body.code).toBe('validation_failed');

    const noWorkspace = await request(buildApp(undefined)).get(
      `/api/devportal/webhooks?app_id=${appId}`
    );
    expect(noWorkspace.status).toBe(400);
  });

  it('routes /webhooks/deliveries as a literal, not as a subscription id', async () => {
    const res = await request(buildApp(workspaceId)).get(
      `/api/devportal/webhooks/deliveries?app_id=${appId}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('answers with the ApiError envelope, not the internal {success,data} shape', async () => {
    const res = await request(buildApp(workspaceId)).get(
      `/api/devportal/webhooks?app_id=${otherAppId}`
    );
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('request_id');
    expect(res.body).not.toHaveProperty('success');
  });
});
