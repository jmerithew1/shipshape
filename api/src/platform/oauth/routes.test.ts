/**
 * OAuth protocol endpoint tests.
 *
 * The router takes its session middleware by injection, so the whole
 * human-consent half of the protocol is exercised here with a three-line fake
 * instead of a real login — that is the entire reason `auth` is a parameter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { pool } from '../../db/client.js';
import { createOAuthRouter, DEVICE_CODE_GRANT_TYPE } from './routes.js';
import { registerApp, rotateAppSecret, sha256Hex } from './service.js';
import type { OAuthAppRow } from './service.js';

// RFC 7636 Appendix B — the canonical S256 pair, used end to end here.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const REDIRECT_URI = 'https://client.example.com/callback';
const SCOPES = ['documents:read', 'documents:write'];

describe('OAuth routes', () => {
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let workspaceId: string;
  let userId: string;

  const auth: RequestHandler = (req, _res, next) => {
    req.userId = userId;
    req.workspaceId = workspaceId;
    next();
  };

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/oauth', createOAuthRouter({ auth }));

  async function newApp(overrides: Partial<Parameters<typeof registerApp>[0]> = {}) {
    return registerApp({
      workspaceId,
      ownerUserId: userId,
      name: `Route App ${runId}`,
      redirectUris: [REDIRECT_URI],
      requestedScopes: SCOPES,
      ...overrides,
    });
  }

  /** Drive consent to a fresh authorization code for `oauthApp`. */
  async function grantCode(oauthApp: OAuthAppRow, scope = 'documents:read'): Promise<string> {
    const res = await request(app)
      .post('/oauth/authorize/decision')
      .send({
        client_id: oauthApp.client_id,
        redirect_uri: REDIRECT_URI,
        scope,
        state: 'xyz',
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        approve: true,
      });
    expect(res.status).toBe(200);
    const code = new URL(res.body.redirect_to).searchParams.get('code');
    expect(code).toBeTruthy();
    return code!;
  }

  /** Full authorization-code exchange, returning the token response. */
  async function exchangeCode(oauthApp: OAuthAppRow, scope = 'documents:read') {
    const code = await grantCode(oauthApp, scope);
    return request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
    });
  }

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`OAuth Routes ${runId}`]
    );
    workspaceId = ws.rows[0]!.id;

    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'x', 'OAuth Routes Test') RETURNING id`,
      [`oauth-routes-${runId}@ship.local`]
    );
    userId = user.rows[0]!.id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId]
    );
  });

  afterAll(async () => {
    if (workspaceId) await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    if (userId) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  // ── GET /oauth/authorize ──────────────────────────────────────────────────

  it('returns consent context for a valid authorization request', async () => {
    const { app: oauthApp } = await newApp();
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
      scope: 'documents:read documents:write',
      state: 'opaque-state',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      app_name: oauthApp.name,
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
      scopes: [
        { scope: 'documents:read', description: 'Read documents in the workspace' },
        {
          scope: 'documents:write',
          description: 'Create and update documents in the workspace',
        },
      ],
      state: 'opaque-state',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
  });

  it('rejects a non-code response_type', async () => {
    const { app: oauthApp } = await newApp();
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'token',
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_response_type');
    expect(res.body.error_description).toBeTypeOf('string');
  });

  it('rejects an unknown client_id', async () => {
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: 'ship_app_0000000000000000',
      redirect_uri: REDIRECT_URI,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
  });

  it('rejects a redirect_uri that is not an exact registered match', async () => {
    const { app: oauthApp } = await newApp();
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: oauthApp.client_id,
      // One extra path segment: prefix matching would let this through, which
      // is the classic open-redirect.
      redirect_uri: `${REDIRECT_URI}/evil`,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects scope escalation beyond the app registered scopes', async () => {
    const { app: oauthApp } = await newApp();
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
      scope: 'documents:read webhooks:manage',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
    expect(res.body.error_description).toContain('webhooks:manage');
  });

  it('rejects a code_challenge_method other than S256', async () => {
    const { app: oauthApp } = await newApp();
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: CHALLENGE,
      code_challenge_method: 'plain',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  // ── POST /oauth/authorize/decision ────────────────────────────────────────

  it('approval returns a redirect carrying the code and the state', async () => {
    const { app: oauthApp } = await newApp();
    const res = await request(app).post('/oauth/authorize/decision').send({
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
      scope: 'documents:read',
      state: 'state-123',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      approve: true,
    });

    expect(res.status).toBe(200);
    const url = new URL(res.body.redirect_to);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT_URI);
    expect(url.searchParams.get('code')!.startsWith('ship_ac_')).toBe(true);
    expect(url.searchParams.get('state')).toBe('state-123');
  });

  it('denial returns a redirect carrying access_denied and no code', async () => {
    const { app: oauthApp } = await newApp();
    const res = await request(app).post('/oauth/authorize/decision').send({
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
      scope: 'documents:read',
      state: 'state-456',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      approve: false,
    });

    expect(res.status).toBe(200);
    const url = new URL(res.body.redirect_to);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('state-456');
    expect(url.searchParams.get('code')).toBeNull();
  });

  it('re-validates scope on decision so an edited consent body cannot escalate', async () => {
    const { app: oauthApp } = await newApp();
    const res = await request(app).post('/oauth/authorize/decision').send({
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
      scope: 'webhooks:manage',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      approve: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
  });

  // ── POST /oauth/token: authorization_code ─────────────────────────────────

  it('exchanges an authorization code for tokens (urlencoded body)', async () => {
    const { app: oauthApp } = await newApp();
    const res = await exchangeCode(oauthApp);

    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBe(3600);
    expect(res.body.scope).toBe('documents:read');
    expect(res.body.access_token.startsWith('ship_')).toBe(true);
    expect(res.body.refresh_token.startsWith('ship_rt_')).toBe(true);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('accepts a JSON token request as well as a form one', async () => {
    const { app: oauthApp } = await newApp();
    const code = await grantCode(oauthApp);
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
    });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
  });

  it('rejects a wrong code_verifier with invalid_grant', async () => {
    const { app: oauthApp } = await newApp();
    const code = await grantCode(oauthApp);
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'z'.repeat(43),
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects a replayed authorization code with invalid_grant', async () => {
    const { app: oauthApp } = await newApp();
    const code = await grantCode(oauthApp);
    const payload = {
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
    };

    expect((await request(app).post('/oauth/token').type('form').send(payload)).status).toBe(200);
    const replay = await request(app).post('/oauth/token').type('form').send(payload);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
  });

  it('rejects an expired authorization code with invalid_grant', async () => {
    const { app: oauthApp } = await newApp();
    const code = await grantCode(oauthApp);
    await pool.query(
      `UPDATE oauth_authorization_codes SET expires_at = NOW() - INTERVAL '1 second'
        WHERE code_hash = $1`,
      [sha256Hex(code)]
    );

    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      client_id: oauthApp.client_id,
      redirect_uri: REDIRECT_URI,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects a redirect_uri that differs from the one bound to the code', async () => {
    const { app: oauthApp } = await newApp({
      redirectUris: [REDIRECT_URI, 'https://client.example.com/other'],
    });
    const code = await grantCode(oauthApp);
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      client_id: oauthApp.client_id,
      // Registered for this app, but not the URI this code was issued against.
      redirect_uri: 'https://client.example.com/other',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects an unsupported grant_type', async () => {
    const res = await request(app).post('/oauth/token').type('form').send({ grant_type: 'password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  // ── Device grant ──────────────────────────────────────────────────────────

  async function startDevice(oauthApp: OAuthAppRow, scope = 'documents:read') {
    const res = await request(app)
      .post('/oauth/device/code')
      .type('form')
      .send({ client_id: oauthApp.client_id, scope });
    expect(res.status).toBe(200);
    return res;
  }

  function pollDevice(oauthApp: OAuthAppRow, deviceCode: string) {
    return request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: oauthApp.client_id,
      });
  }

  /** Backdate the poll stamp so the next poll is not throttled. No sleeping. */
  async function clearPollThrottle(deviceCode: string) {
    await pool.query(
      `UPDATE oauth_device_codes SET last_polled_at = NOW() - INTERVAL '1 hour'
        WHERE device_code_hash = $1`,
      [sha256Hex(deviceCode)]
    );
  }

  it('issues a device code with a verification URI and polling interval', async () => {
    const { app: oauthApp } = await newApp();
    const res = await startDevice(oauthApp);

    expect(res.body.device_code.startsWith('ship_dc_')).toBe(true);
    expect(res.body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.body.verification_uri).toBe('/device');
    expect(res.body.verification_uri_complete).toBe(
      `/device?user_code=${encodeURIComponent(res.body.user_code)}`
    );
    expect(res.body.expires_in).toBe(900);
    expect(res.body.interval).toBe(5);
  });

  it('device happy path: verify, then poll once for tokens', async () => {
    const { app: oauthApp } = await newApp();
    const device = await startDevice(oauthApp);

    const verify = await request(app)
      .post('/oauth/device/verify')
      .send({ user_code: device.body.user_code, approve: true });
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('approved');

    const token = await pollDevice(oauthApp, device.body.device_code);
    expect(token.status).toBe(200);
    expect(token.body.token_type).toBe('Bearer');
    expect(token.body.scope).toBe('documents:read');
    expect(token.body.refresh_token).toBeTruthy();
  });

  it('device polling before approval returns authorization_pending', async () => {
    const { app: oauthApp } = await newApp();
    const device = await startDevice(oauthApp);
    const res = await pollDevice(oauthApp, device.body.device_code);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('authorization_pending');
  });

  it('device polling twice inside the interval returns slow_down', async () => {
    const { app: oauthApp } = await newApp();
    const device = await startDevice(oauthApp);
    await pollDevice(oauthApp, device.body.device_code);
    const res = await pollDevice(oauthApp, device.body.device_code);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('slow_down');
  });

  it('device denial returns access_denied', async () => {
    const { app: oauthApp } = await newApp();
    const device = await startDevice(oauthApp);

    const verify = await request(app)
      .post('/oauth/device/verify')
      .send({ user_code: device.body.user_code, approve: false });
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('denied');

    const res = await pollDevice(oauthApp, device.body.device_code);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('access_denied');
  });

  it('an expired device code returns expired_token', async () => {
    const { app: oauthApp } = await newApp();
    const device = await startDevice(oauthApp);
    await pool.query(
      `UPDATE oauth_device_codes SET expires_at = NOW() - INTERVAL '1 second'
        WHERE device_code_hash = $1`,
      [sha256Hex(device.body.device_code)]
    );

    const res = await pollDevice(oauthApp, device.body.device_code);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('expired_token');
  });

  it('a device code mints exactly one token set', async () => {
    const { app: oauthApp } = await newApp();
    const device = await startDevice(oauthApp);
    await request(app)
      .post('/oauth/device/verify')
      .send({ user_code: device.body.user_code, approve: true });

    expect((await pollDevice(oauthApp, device.body.device_code)).status).toBe(200);

    await clearPollThrottle(device.body.device_code);
    const second = await pollDevice(oauthApp, device.body.device_code);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });

  it('device verification accepts a lowercase, dashless user code', async () => {
    const { app: oauthApp } = await newApp();
    const device = await startDevice(oauthApp);
    const sloppy = (device.body.user_code as string).replace('-', '').toLowerCase();

    const verify = await request(app)
      .post('/oauth/device/verify')
      .send({ user_code: sloppy, approve: true });
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('approved');
  });

  it('verifying an unknown user code returns invalid_grant', async () => {
    const res = await request(app)
      .post('/oauth/device/verify')
      .send({ user_code: 'AAAA-AAAA', approve: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  // ── Refresh rotation ──────────────────────────────────────────────────────

  it('rotates a refresh token into a fresh pair', async () => {
    const { app: oauthApp } = await newApp();
    const first = await exchangeCode(oauthApp);

    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: first.body.refresh_token,
      client_id: oauthApp.client_id,
    });

    expect(res.status).toBe(200);
    expect(res.body.refresh_token).not.toBe(first.body.refresh_token);
    expect(res.body.access_token).not.toBe(first.body.access_token);
    expect(res.body.scope).toBe('documents:read');
  });

  it('replaying a refresh token revokes the family and its access tokens', async () => {
    const { app: oauthApp } = await newApp();
    const first = await exchangeCode(oauthApp);

    const second = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: first.body.refresh_token,
      client_id: oauthApp.client_id,
    });
    expect(second.status).toBe(200);

    const replay = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: first.body.refresh_token,
      client_id: oauthApp.client_id,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');

    const family = await pool.query<{ refresh_family_id: string }>(
      `SELECT refresh_family_id FROM api_tokens WHERE token_hash = $1`,
      [sha256Hex(first.body.access_token)]
    );
    const familyId = family.rows[0]!.refresh_family_id;

    const live = await pool.query(
      `SELECT 1 FROM api_tokens WHERE refresh_family_id = $1 AND revoked_at IS NULL`,
      [familyId]
    );
    expect(live.rows).toHaveLength(0);

    // The generation-2 token issued moments before the replay is dead too.
    const afterKill = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: second.body.refresh_token,
      client_id: oauthApp.client_id,
    });
    expect(afterKill.status).toBe(400);
    expect(afterKill.body.error).toBe('invalid_grant');
  });

  it('rejects an unknown refresh token', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: 'ship_rt_nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  // ── client_credentials ────────────────────────────────────────────────────

  it('issues a first-party client_credentials token with no refresh token', async () => {
    const { app: oauthApp, rawClientSecret } = await newApp({ isFirstParty: true });
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'client_credentials',
      client_id: oauthApp.client_id,
      client_secret: rawClientSecret,
      scope: 'documents:read',
    });

    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.scope).toBe('documents:read');
    // RFC 6749 §4.4.3: no refresh token for client_credentials.
    expect(res.body.refresh_token).toBeUndefined();

    // Bound to the app owner and workspace, not to any interactive session.
    const row = await pool.query<{ user_id: string; workspace_id: string; oauth_app_id: string }>(
      `SELECT user_id, workspace_id, oauth_app_id FROM api_tokens WHERE token_hash = $1`,
      [sha256Hex(res.body.access_token)]
    );
    expect(row.rows[0]!.user_id).toBe(userId);
    expect(row.rows[0]!.workspace_id).toBe(workspaceId);
    expect(row.rows[0]!.oauth_app_id).toBe(oauthApp.id);
  });

  it('accepts client_credentials over HTTP Basic', async () => {
    const { app: oauthApp, rawClientSecret } = await newApp({ isFirstParty: true });
    const basic = Buffer.from(`${oauthApp.client_id}:${rawClientSecret}`).toString('base64');

    const res = await request(app)
      .post('/oauth/token')
      .set('Authorization', `Basic ${basic}`)
      .type('form')
      .send({ grant_type: 'client_credentials' });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
  });

  it('refuses client_credentials for a non-first-party app', async () => {
    const { app: oauthApp, rawClientSecret } = await newApp();
    expect(oauthApp.is_first_party).toBe(false);

    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'client_credentials',
      client_id: oauthApp.client_id,
      client_secret: rawClientSecret,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
  });

  it('a rotated secret stops authenticating and the new one starts', async () => {
    const { app: oauthApp, rawClientSecret: oldSecret } = await newApp({ isFirstParty: true });
    const rotated = await rotateAppSecret(oauthApp.id);

    const withOld = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'client_credentials',
      client_id: oauthApp.client_id,
      client_secret: oldSecret,
    });
    expect(withOld.status).toBe(400);
    expect(withOld.body.error).toBe('invalid_client');

    const withNew = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'client_credentials',
      client_id: oauthApp.client_id,
      client_secret: rotated!.rawClientSecret,
    });
    expect(withNew.status).toBe(200);
  });

  it('a bad Basic credential is a 401 with WWW-Authenticate', async () => {
    const { app: oauthApp } = await newApp({ isFirstParty: true });
    const basic = Buffer.from(`${oauthApp.client_id}:ship_sec_wrong`).toString('base64');

    const res = await request(app)
      .post('/oauth/token')
      .set('Authorization', `Basic ${basic}`)
      .type('form')
      .send({ grant_type: 'client_credentials' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(res.headers['www-authenticate']).toContain('Basic');
  });

  it('refuses client_credentials scope escalation', async () => {
    const { app: oauthApp, rawClientSecret } = await newApp({ isFirstParty: true });
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'client_credentials',
      client_id: oauthApp.client_id,
      client_secret: rawClientSecret,
      scope: 'webhooks:manage',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
  });
});
