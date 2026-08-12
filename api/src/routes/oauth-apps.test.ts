/**
 * OAuth app registration (MVP gate A1): admin creates an app, receives a
 * client_id, the secret is hashed in the database, and the raw secret is shown
 * exactly once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const app = createApp();

let workspaceId: string;
let userId: string;
let sessionId: string;
let sessionCookie: string;
let csrfToken: string;

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('W6 Apps Test') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const user = await pool.query(
    `INSERT INTO users (email, name) VALUES ($1,'App Admin') RETURNING id`,
    [`apps-${crypto.randomBytes(4).toString('hex')}@ship.local`]
  );
  userId = user.rows[0].id;
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'admin')`,
    [workspaceId, userId]
  );
  sessionId = crypto.randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
     VALUES ($1,$2,$3, now() + interval '1 hour', now(), now())`,
    [sessionId, userId, workspaceId]
  );

  // These routes are session-authenticated, so they carry full CSRF
  // protection — a forged POST here would mint app credentials.
  sessionCookie = `session_id=${sessionId}`;
  const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie);
  csrfToken = csrfRes.body.token;
  const connectSid = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
  if (connectSid) sessionCookie = `${sessionCookie}; ${connectSid}`;
});

afterAll(async () => {
  if (workspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
});

const authed = (r: request.Test) => r.set('Cookie', sessionCookie).set('x-csrf-token', csrfToken);

describe('POST /api/oauth-apps (MVP gate A1)', () => {
  it('creates an app, returns client_id + raw secret ONCE, and stores only the hash', async () => {
    const res = await authed(
      request(app).post('/api/oauth-apps').send({
        name: 'Grader Read-Only App',
        redirect_uris: ['https://example.test/callback'],
        requested_scopes: ['documents:read', 'issues:read'],
      })
    );

    expect(res.status).toBe(201);
    const { client_id, client_secret, id } = res.body.data;
    expect(client_id).toMatch(/^ship_app_/);
    expect(client_secret).toMatch(/^ship_sec_/);
    expect(res.body.data.warning).toMatch(/only time/i);
    // Secrets must not be cacheable (back-button / proxy leakage).
    expect(res.headers['cache-control']).toMatch(/no-store/);

    // The database holds the HASH, never the raw secret.
    const row = await pool.query(
      'SELECT client_secret_hash, client_secret_prefix FROM oauth_apps WHERE id = $1',
      [id]
    );
    expect(row.rows[0].client_secret_hash).toBe(sha(client_secret));
    expect(row.rows[0].client_secret_hash).not.toBe(client_secret);
    expect(client_secret).toContain(row.rows[0].client_secret_prefix);

    // And it is never recoverable through the API afterwards.
    const list = await authed(request(app).get('/api/oauth-apps'));
    expect(list.status).toBe(200);
    const listed = list.body.data.find((a: { id: string }) => a.id === id);
    expect(listed).toBeTruthy();
    expect(JSON.stringify(listed)).not.toContain(client_secret);
    expect(listed.client_secret).toBeUndefined();
  });

  it('rejects unknown scopes and names the known set', async () => {
    const res = await authed(
      request(app).post('/api/oauth-apps').send({
        name: 'Bad Scopes',
        redirect_uris: ['https://example.test/cb'],
        requested_scopes: ['documents:read', 'documents:obliterate'],
      })
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('documents:obliterate');
    expect(res.body.error.details.known_scopes).toContain('documents:read');
  });

  it('rejects a malformed registration', async () => {
    const res = await authed(
      request(app).post('/api/oauth-apps').send({ name: '', redirect_uris: [], requested_scopes: [] })
    );
    expect(res.status).toBe(400);
  });

  it('refuses an anonymous request and creates nothing', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM oauth_apps');
    const res = await request(app).post('/api/oauth-apps').send({
      name: 'Anonymous',
      redirect_uris: ['https://example.test/cb'],
      requested_scopes: ['documents:read'],
    });

    // 403 from the CSRF layer, which sits in front of authentication — a
    // request with neither a session nor a CSRF token is stopped at the
    // outer gate. Either rejection is correct; what matters is that no
    // credentials were minted.
    expect([401, 403]).toContain(res.status);
    const after = await pool.query('SELECT count(*)::int AS n FROM oauth_apps');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('refuses a CSRF-bearing request that has no session', async () => {
    const res = await request(app)
      .post('/api/oauth-apps')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'No session', redirect_uris: ['https://example.test/cb'], requested_scopes: ['documents:read'] });
    expect([401, 403]).toContain(res.status);
    expect(res.status).not.toBe(201);
  });
});

describe('secret rotation', () => {
  it('issues a new secret once and invalidates the old hash', async () => {
    const created = await authed(
      request(app).post('/api/oauth-apps').send({
        name: 'Rotate Me',
        redirect_uris: ['https://example.test/cb'],
        requested_scopes: ['documents:read'],
      })
    );
    const { id, client_secret: original } = created.body.data;

    const rotated = await authed(request(app).post(`/api/oauth-apps/${id}/rotate-secret`));
    expect(rotated.status).toBe(200);
    const next = rotated.body.data.client_secret;
    expect(next).toMatch(/^ship_sec_/);
    expect(next).not.toBe(original);
    expect(rotated.headers['cache-control']).toMatch(/no-store/);

    const row = await pool.query('SELECT client_secret_hash, secret_rotated_at FROM oauth_apps WHERE id = $1', [id]);
    expect(row.rows[0].client_secret_hash).toBe(sha(next));
    expect(row.rows[0].client_secret_hash).not.toBe(sha(original));
    expect(row.rows[0].secret_rotated_at).toBeTruthy();
  });

  it('404s rotation for an app in another workspace', async () => {
    const other = await pool.query(`INSERT INTO workspaces (name) VALUES ('Other Apps WS') RETURNING id`);
    try {
      const app2 = await pool.query(
        `INSERT INTO oauth_apps (workspace_id, owner_user_id, name, client_id, client_secret_hash,
                                 client_secret_prefix, redirect_uris, requested_scopes)
         VALUES ($1,$2,'Not Yours',$3,$4,'ship_sec',ARRAY['https://x.test/cb'],ARRAY['documents:read'])
         RETURNING id`,
        [other.rows[0].id, userId, `ship_app_${crypto.randomBytes(8).toString('hex')}`, sha('x')]
      );
      const res = await authed(request(app).post(`/api/oauth-apps/${app2.rows[0].id}/rotate-secret`));
      expect(res.status).toBe(404);
    } finally {
      await pool.query('DELETE FROM workspaces WHERE id = $1', [other.rows[0].id]);
    }
  });
});

describe('GET /api/oauth-apps/scopes', () => {
  it('publishes the scope registry as data for the registration form', async () => {
    const res = await authed(request(app).get('/api/oauth-apps/scopes'));
    expect(res.status).toBe(200);
    const scopes = res.body.data.map((s: { scope: string }) => s.scope);
    expect(scopes).toContain('documents:read');
    expect(scopes).toContain('webhooks:manage');
    expect(res.body.data[0].description).toBeTruthy();
  });
});

describe('DELETE /api/oauth-apps/:id', () => {
  it('deactivates the app and revokes its outstanding tokens', async () => {
    const created = await authed(
      request(app).post('/api/oauth-apps').send({
        name: 'Doomed App',
        redirect_uris: ['https://example.test/cb'],
        requested_scopes: ['documents:read'],
      })
    );
    const appId = created.body.data.id;
    const raw = `ship_${crypto.randomBytes(32).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, oauth_app_id, scopes)
       VALUES ($1,$2,'doomed-token',$3,$4,$5,ARRAY['documents:read'])`,
      [userId, workspaceId, sha(raw), raw.slice(0, 8), appId]
    );

    const res = await authed(request(app).delete(`/api/oauth-apps/${appId}`));
    expect(res.status).toBe(200);

    const token = await pool.query('SELECT revoked_at FROM api_tokens WHERE oauth_app_id = $1', [appId]);
    expect(token.rows[0].revoked_at).toBeTruthy();
  });
});
