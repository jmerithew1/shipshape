/**
 * Regression tests for defects found by the Week-6 contract + security audits.
 * Each test names the finding it locks down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import express from 'express';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { createV1Router } from './router.js';
import { tokenGate } from './middleware/authn.js';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const app = createApp();

let workspaceId: string;
let userId: string;
let appId: string;
let token: string;
let adminToken: string;

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('W6 Audit Fixes') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const u = await pool.query(
    `INSERT INTO users (email, name, is_super_admin) VALUES ($1,'Audit Admin', true) RETURNING id`,
    [`audit-${crypto.randomBytes(4).toString('hex')}@ship.local`]
  );
  userId = u.rows[0].id;
  const a = await pool.query(
    `INSERT INTO oauth_apps (workspace_id, owner_user_id, name, client_id, client_secret_hash,
                             client_secret_prefix, redirect_uris, requested_scopes)
     VALUES ($1,$2,'Audit App',$3,$4,'ship_sec',ARRAY['https://x.test/cb'],ARRAY['documents:read'])
     RETURNING id`,
    [workspaceId, userId, `ship_app_${crypto.randomBytes(8).toString('hex')}`, sha('s')]
  );
  appId = a.rows[0].id;

  token = `ship_${crypto.randomBytes(32).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, oauth_app_id, scopes)
     VALUES ($1,$2,'audit-oauth',$3,$4,$5,ARRAY['documents:read'])`,
    [userId, workspaceId, sha(token), token.slice(0, 8), appId]
  );
  adminToken = `ship_${crypto.randomBytes(32).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, oauth_app_id, scopes)
     VALUES ($1,$2,'audit-pat',$3,$4,NULL,NULL)`,
    [userId, workspaceId, sha(adminToken), adminToken.slice(0, 8)]
  );
});

afterAll(async () => {
  if (workspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
});

describe('security audit #5 — super-admin is not delegable to an OAuth app', () => {
  it('strips is_super_admin from an OAuth-issued token even when the user IS a super-admin', async () => {
    const probe = express();
    probe.use(
      '/api/v1',
      createV1Router((r) => {
        r.get('/whoami', tokenGate, (req: express.Request, res: express.Response) => {
          res.json({ isSuperAdmin: req.platform!.isSuperAdmin, oauthAppId: req.platform!.oauthAppId });
        });
      })
    );

    const viaApp = await request(probe).get('/api/v1/whoami').set('Authorization', `Bearer ${token}`);
    expect(viaApp.status).toBe(200);
    expect(viaApp.body.oauthAppId).toBeTruthy();
    expect(viaApp.body.isSuperAdmin).toBe(false); // delegated ≠ admin

    const viaPat = await request(probe).get('/api/v1/whoami').set('Authorization', `Bearer ${adminToken}`);
    expect(viaPat.body.oauthAppId).toBeNull();
    expect(viaPat.body.isSuperAdmin).toBe(true); // the human themselves keeps it
  });
});

describe('security audit #1 — CSRF cannot be skipped by path shape', () => {
  const forgeries = [
    '/oauth/device/verify/',
    '/oauth/device/VERIFY',
    '/oauth/Device/Verify/',
    '/oauth/authorize/decision/',
    '/oauth/authorize/DECISION',
  ];

  for (const path of forgeries) {
    it(`refuses a CSRF-less POST to ${path}`, async () => {
      const res = await request(app).post(path).send({ user_code: 'ACDE-F234', approve: true });
      // 403 = CSRF rejected. It must NOT reach the handler (which would 401
      // for no session, or worse, succeed with one).
      expect(res.status).toBe(403);
    });
  }
});

describe('contract audit #3 — cursor stability against REAL SQL, not a simulation', () => {
  it('never skips a row that is edited while the client is paging', async () => {
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('W6 Cursor Truth') RETURNING id`);
    const wsId = ws.rows[0].id;
    const t = `ship_${crypto.randomBytes(32).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix)
       VALUES ($1,$2,'cursor-truth',$3,$4)`,
      [userId, wsId, sha(t), t.slice(0, 8)]
    );
    try {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await pool.query(
          `INSERT INTO documents (workspace_id, document_type, title, created_by, created_at, updated_at)
           VALUES ($1,'wiki',$2,$3, now() - ($4 || ' minutes')::interval, now() - ($4 || ' minutes')::interval)
           RETURNING id`,
          [wsId, `Doc ${i}`, userId, String(i)]
        );
        ids.push(r.rows[0].id);
      }

      const page1 = await request(app)
        .get('/api/v1/documents?limit=3')
        .set('Authorization', `Bearer ${t}`);
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(3);

      // THE ATTACK ON THE INVARIANT: touch a document that has not been
      // returned yet. With updated_at as the sort key this row jumped above
      // the cursor and vanished from the walk entirely.
      const notYetSeen = ids[5]!;
      await pool.query('UPDATE documents SET updated_at = now() WHERE id = $1', [notYetSeen]);

      const seen = page1.body.data.map((d: { id: string }) => d.id);
      let cursor: string | null = page1.body.next_cursor;
      while (cursor) {
        const next: { body: { data: { id: string }[]; next_cursor: string | null } } = await request(app)
          .get(`/api/v1/documents?limit=3&cursor=${encodeURIComponent(cursor)}`)
          .set('Authorization', `Bearer ${t}`);
        seen.push(...next.body.data.map((d) => d.id));
        cursor = next.body.next_cursor;
      }

      expect(seen).toContain(notYetSeen);           // the edited row was still delivered
      expect(new Set(seen).size).toBe(seen.length); // and delivered exactly once
      expect(seen).toHaveLength(6);
    } finally {
      await pool.query('DELETE FROM workspaces WHERE id = $1', [wsId]);
    }
  });
});
