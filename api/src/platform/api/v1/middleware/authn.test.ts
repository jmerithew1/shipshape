/**
 * TokenGate + requireScope integration tests (MVP gates A3, A4, A6).
 * Real Postgres; every row created here is owned by a per-test workspace and
 * removed by CASCADE in afterEach — no truncation (agent_* convention).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createV1Router } from '../router.js';
import { tokenGate } from './authn.js';
import { requireScope } from './scope.js';
import { API_ERROR_CODES } from '../errors.js';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

let workspaceId: string;
let userId: string;
let appId: string;
let clientId: string;
let tokenSeq = 0;

async function mintToken(opts: {
  scopes?: string[] | null;
  oauthApp?: boolean;
  expiresAt?: string | null;
  revoked?: boolean;
}): Promise<string> {
  const raw = `ship_${crypto.randomBytes(32).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix,
                             expires_at, revoked_at, oauth_app_id, scopes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      userId,
      workspaceId,
      `test-token-${tokenSeq++}`,
      sha(raw),
      raw.slice(0, 8),
      opts.expiresAt ?? null,
      opts.revoked ? new Date().toISOString() : null,
      opts.oauthApp ? appId : null,
      opts.scopes ?? null,
    ]
  );
  return raw;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createV1Router((r) => {
      r.get('/probe', tokenGate, requireScope('documents:read'), (req, res) => {
        res.json({ userId: req.platform!.userId, scopes: req.platform!.grantedScopes, clientId: req.platform!.clientId });
      });
    })
  );
  return app;
}

function assertEnvelope(res: { body: Record<string, unknown>; headers: Record<string, string> }) {
  expect(API_ERROR_CODES).toContain(res.body.code);
  expect(typeof res.body.message).toBe('string');
  expect(typeof res.body.request_id).toBe('string');
  expect(res.body.request_id).toBe(res.headers['x-request-id']);
  for (const key of Object.keys(res.body)) {
    expect(['code', 'message', 'details', 'request_id']).toContain(key);
  }
}

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('W6 Gate Test') RETURNING id`);
  workspaceId = ws.rows[0].id;

  const user = await pool.query(
    `INSERT INTO users (email, name) VALUES ($1,'Gate Tester') RETURNING id`,
    [`gate-${crypto.randomBytes(4).toString('hex')}@ship.local`]
  );
  userId = user.rows[0].id;

  clientId = `ship_app_${crypto.randomBytes(8).toString('hex')}`;
  const app = await pool.query(
    `INSERT INTO oauth_apps (workspace_id, owner_user_id, name, client_id,
                             client_secret_hash, client_secret_prefix, redirect_uris, requested_scopes)
     VALUES ($1,$2,'Gate Test App',$3,$4,'ship_sec',ARRAY['https://example.test/cb'],
             ARRAY['documents:read','issues:read'])
     RETURNING id`,
    [workspaceId, userId, clientId, sha('secret')]
  );
  appId = app.rows[0].id;
});

afterAll(async () => {
  // Workspace CASCADE removes api_tokens + oauth_apps; users are global
  // (workspaces do not own them), so this suite deletes its own user row.
  if (workspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
});

describe('tokenGate — authentication (MVP gate A3)', () => {
  it('401s a request with no Authorization header', async () => {
    const res = await request(buildApp()).get('/api/v1/probe');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    assertEnvelope(res);
  });

  it('401s a non-bearer scheme', async () => {
    const res = await request(buildApp()).get('/api/v1/probe').set('Authorization', 'Basic abc123');
    expect(res.status).toBe(401);
    assertEnvelope(res);
  });

  it('401s an unknown token', async () => {
    const res = await request(buildApp()).get('/api/v1/probe').set('Authorization', 'Bearer ship_nope');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('401s a revoked token', async () => {
    const token = await mintToken({ oauthApp: true, scopes: ['documents:read'], revoked: true });
    const res = await request(buildApp()).get('/api/v1/probe').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('401s an EXPIRED token with a DISTINCT code (token_expired)', async () => {
    const token = await mintToken({
      oauthApp: true,
      scopes: ['documents:read'],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await request(buildApp()).get('/api/v1/probe').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_expired');
    expect(res.body.code).not.toBe('unauthorized');
    assertEnvelope(res);
  });

  it('401s a token whose OAuth app has been deactivated', async () => {
    const token = await mintToken({ oauthApp: true, scopes: ['documents:read'] });
    await pool.query('UPDATE oauth_apps SET active = false WHERE id = $1', [appId]);
    try {
      const res = await request(buildApp()).get('/api/v1/probe').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    } finally {
      await pool.query('UPDATE oauth_apps SET active = true WHERE id = $1', [appId]);
    }
  });

  it('accepts a valid OAuth token and exposes app context', async () => {
    const token = await mintToken({ oauthApp: true, scopes: ['documents:read'] });
    const res = await request(buildApp()).get('/api/v1/probe').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(userId);
    expect(res.body.clientId).toBe(clientId);
    expect(res.body.scopes).toEqual(['documents:read']);
  });

  it('treats a personal access token as the resource owner (all scopes)', async () => {
    const token = await mintToken({ oauthApp: false, scopes: null });
    const res = await request(buildApp()).get('/api/v1/probe').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBeNull();
    expect(res.body.scopes).toContain('documents:read');
    expect(res.body.scopes).toContain('webhooks:manage');
  });
});

describe('requireScope — authorization (MVP gates A4, A6)', () => {
  it('403s insufficient scope and NAMES the missing scope explicitly', async () => {
    const token = await mintToken({ oauthApp: true, scopes: ['issues:read'] });
    const res = await request(buildApp()).get('/api/v1/probe').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    expect(res.body.message).toContain('documents:read');
    expect(res.body.details).toEqual({ missing_scope: 'documents:read' });
    assertEnvelope(res);
  });

  it('403s a token granted no scopes at all', async () => {
    const token = await mintToken({ oauthApp: true, scopes: [] });
    const res = await request(buildApp()).get('/api/v1/probe').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.details).toEqual({ missing_scope: 'documents:read' });
  });

  it('rejects an unknown scope at factory time, not at request time', () => {
    expect(() => requireScope('documents:destroy')).toThrow(/Unknown scope/);
  });
});
