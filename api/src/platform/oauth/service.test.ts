/**
 * OAuth core service tests.
 *
 * These run against real Postgres because every security property under test
 * — one-time-consume, family revocation, slow_down — is enforced by a SQL
 * statement, not by TypeScript. Mocking the pool would test the mock.
 *
 * No test ever sleeps. Where elapsed time matters, the row's timestamp is
 * backdated instead: a suite that waits 10 real minutes for a code to expire
 * is a suite nobody runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../db/client.js';
import {
  ACCESS_TOKEN_PREFIX,
  AUTHORIZATION_CODE_PREFIX,
  CLIENT_ID_PREFIX,
  CLIENT_SECRET_PREFIX,
  DEVICE_CODE_PREFIX,
  REFRESH_TOKEN_PREFIX,
  USER_CODE_ALPHABET,
  approveDeviceCode,
  authenticateApp,
  consumeAuthorizationCode,
  createAuthorizationCode,
  createDeviceCode,
  denyDeviceCode,
  deriveCodeChallenge,
  issueTokens,
  normalizeUserCode,
  pollDeviceCode,
  registerApp,
  rotateAppSecret,
  rotateRefreshToken,
  sha256Hex,
  verifyPkce,
} from './service.js';
import type { OAuthAppRow } from './service.js';

// RFC 7636 Appendix B — the canonical S256 test vector.
const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const REDIRECT_URI = 'https://client.example.com/callback';

describe('OAuth service', () => {
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let workspaceId: string;
  let userId: string;

  async function newApp(overrides: Partial<Parameters<typeof registerApp>[0]> = {}) {
    return registerApp({
      workspaceId,
      ownerUserId: userId,
      name: `Svc App ${runId}`,
      redirectUris: [REDIRECT_URI],
      requestedScopes: ['documents:read', 'documents:write'],
      ...overrides,
    });
  }

  async function newCode(app: OAuthAppRow, challenge = RFC7636_CHALLENGE) {
    return createAuthorizationCode({
      appId: app.id,
      userId,
      workspaceId,
      redirectUri: REDIRECT_URI,
      scopes: ['documents:read'],
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });
  }

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`OAuth Svc ${runId}`]
    );
    workspaceId = ws.rows[0]!.id;

    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'x', 'OAuth Service Test') RETURNING id`,
      [`oauth-svc-${runId}@ship.local`]
    );
    userId = user.rows[0]!.id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId]
    );
  });

  afterAll(async () => {
    // Everything this suite created hangs off the workspace (oauth_apps,
    // api_tokens) or the user, both by ON DELETE CASCADE. No TRUNCATE.
    if (workspaceId) await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    if (userId) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  // ── App registration ──────────────────────────────────────────────────────

  it('registerApp returns the raw secret once and stores only its hash', async () => {
    const { app, rawClientSecret } = await newApp();

    expect(app.client_id.startsWith(CLIENT_ID_PREFIX)).toBe(true);
    expect(app.client_id.slice(CLIENT_ID_PREFIX.length)).toMatch(/^[0-9a-f]{16}$/);
    expect(rawClientSecret.startsWith(CLIENT_SECRET_PREFIX)).toBe(true);
    expect(rawClientSecret.slice(CLIENT_SECRET_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);

    // Stored: sha256 + an 8-character identifying prefix. Never the raw value.
    expect(app.client_secret_hash).toBe(sha256Hex(rawClientSecret));
    expect(app.client_secret_hash).not.toBe(rawClientSecret);
    expect(app.client_secret_prefix).toHaveLength(8);
    expect(rawClientSecret).toContain(app.client_secret_prefix);

    const stored = await pool.query<{ client_secret_hash: string }>(
      `SELECT client_secret_hash FROM oauth_apps WHERE id = $1`,
      [app.id]
    );
    expect(stored.rows[0]!.client_secret_hash).not.toContain(rawClientSecret);
  });

  it('authenticateApp accepts the real secret and rejects a wrong one', async () => {
    const { app, rawClientSecret } = await newApp();

    const ok = await authenticateApp(app.client_id, rawClientSecret);
    expect(ok?.id).toBe(app.id);

    expect(await authenticateApp(app.client_id, `${CLIENT_SECRET_PREFIX}${'0'.repeat(64)}`)).toBeNull();
    expect(await authenticateApp('ship_app_deadbeefdeadbeef', rawClientSecret)).toBeNull();
  });

  it('rotateAppSecret invalidates the old secret immediately', async () => {
    const { app, rawClientSecret: oldSecret } = await newApp();
    expect(await authenticateApp(app.client_id, oldSecret)).not.toBeNull();

    const rotated = await rotateAppSecret(app.id);
    expect(rotated).not.toBeNull();
    const newSecret = rotated!.rawClientSecret;
    expect(newSecret).not.toBe(oldSecret);

    // No grace window: the old secret is dead the instant rotation commits.
    expect(await authenticateApp(app.client_id, oldSecret)).toBeNull();
    expect(await authenticateApp(app.client_id, newSecret)).not.toBeNull();

    const after = await pool.query<{ secret_rotated_at: Date | null }>(
      `SELECT secret_rotated_at FROM oauth_apps WHERE id = $1`,
      [app.id]
    );
    expect(after.rows[0]!.secret_rotated_at).not.toBeNull();
  });

  // ── Authorization codes ───────────────────────────────────────────────────

  it('createAuthorizationCode issues a prefixed code with a 10-minute TTL', async () => {
    const { app } = await newApp();
    const code = await newCode(app);

    expect(code.startsWith(AUTHORIZATION_CODE_PREFIX)).toBe(true);
    expect(code.slice(AUTHORIZATION_CODE_PREFIX.length)).toMatch(/^[0-9a-f]{48}$/);

    const row = await pool.query<{ expires_at: Date; code_hash: string }>(
      `SELECT expires_at, code_hash FROM oauth_authorization_codes WHERE code_hash = $1`,
      [sha256Hex(code)]
    );
    expect(row.rows).toHaveLength(1);
    const ttlSeconds = (row.rows[0]!.expires_at.getTime() - Date.now()) / 1000;
    expect(ttlSeconds).toBeGreaterThan(9 * 60);
    expect(ttlSeconds).toBeLessThanOrEqual(10 * 60 + 5);
  });

  it('consumeAuthorizationCode is one-time-use', async () => {
    const { app } = await newApp();
    const code = await newCode(app);

    const first = await consumeAuthorizationCode(code);
    expect(first?.app_id).toBe(app.id);
    expect(first?.scopes).toEqual(['documents:read']);

    // The DELETE...RETURNING removed the row, so a replay finds nothing.
    expect(await consumeAuthorizationCode(code)).toBeNull();
  });

  it('consumeAuthorizationCode refuses an expired code and leaves it in place', async () => {
    const { app } = await newApp();
    const code = await newCode(app);

    await pool.query(
      `UPDATE oauth_authorization_codes SET expires_at = NOW() - INTERVAL '1 second'
        WHERE code_hash = $1`,
      [sha256Hex(code)]
    );

    expect(await consumeAuthorizationCode(code)).toBeNull();
    const still = await pool.query(
      `SELECT 1 FROM oauth_authorization_codes WHERE code_hash = $1`,
      [sha256Hex(code)]
    );
    expect(still.rows).toHaveLength(1);
  });

  it('consumeAuthorizationCode returns null for an unknown code', async () => {
    expect(await consumeAuthorizationCode('ship_ac_notarealcode')).toBeNull();
  });

  // ── PKCE ──────────────────────────────────────────────────────────────────

  it('derives the RFC 7636 Appendix B challenge from its verifier', () => {
    expect(deriveCodeChallenge(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
    expect(verifyPkce(RFC7636_VERIFIER, RFC7636_CHALLENGE)).toBe(true);
  });

  it('verifyPkce rejects a wrong verifier', () => {
    const wrong = 'a'.repeat(43);
    expect(deriveCodeChallenge(wrong)).not.toBe(RFC7636_CHALLENGE);
    expect(verifyPkce(wrong, RFC7636_CHALLENGE)).toBe(false);
  });

  it('verifyPkce enforces the RFC 7636 verifier grammar', () => {
    // Too short (42), too long (129), and a character outside the unreserved
    // set are all rejected before any hashing happens.
    expect(verifyPkce('a'.repeat(42), deriveCodeChallenge('a'.repeat(42)))).toBe(false);
    expect(verifyPkce('a'.repeat(129), deriveCodeChallenge('a'.repeat(129)))).toBe(false);
    const illegal = `${'a'.repeat(42)}$`;
    expect(verifyPkce(illegal, deriveCodeChallenge(illegal))).toBe(false);
    // The boundary lengths themselves are legal.
    expect(verifyPkce('a'.repeat(43), deriveCodeChallenge('a'.repeat(43)))).toBe(true);
    expect(verifyPkce('b'.repeat(128), deriveCodeChallenge('b'.repeat(128)))).toBe(true);
  });

  // ── Device grant ──────────────────────────────────────────────────────────

  it('createDeviceCode returns a device code and an unambiguous XXXX-XXXX user code', async () => {
    const { app } = await newApp();
    const device = await createDeviceCode({ appId: app.id, scopes: ['documents:read'] });

    expect(device.deviceCode.startsWith(DEVICE_CODE_PREFIX)).toBe(true);
    expect(device.deviceCode.slice(DEVICE_CODE_PREFIX.length)).toMatch(/^[0-9a-f]{48}$/);
    expect(device.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(device.expiresIn).toBe(900);
    expect(device.interval).toBe(5);

    // No character a human could misread as another (no B/8, I/1, L, O/0, S/5, Z/2).
    for (const ch of device.userCode.replace('-', '')) {
      expect(USER_CODE_ALPHABET).toContain(ch);
    }
    expect(normalizeUserCode(device.userCode.replace('-', '').toLowerCase())).toBe(device.userCode);
  });

  it('a fresh device code polls as authorization_pending', async () => {
    const { app } = await newApp();
    const device = await createDeviceCode({ appId: app.id, scopes: ['documents:read'] });
    expect(await pollDeviceCode(device.deviceCode)).toEqual({ status: 'authorization_pending' });
  });

  it('polling again inside the interval returns slow_down', async () => {
    const { app } = await newApp();
    const device = await createDeviceCode({ appId: app.id, scopes: ['documents:read'] });

    expect(await pollDeviceCode(device.deviceCode)).toEqual({ status: 'authorization_pending' });
    // Immediate re-poll: the first poll stamped last_polled_at in the same
    // statement that read it, so the second poll is provably too soon.
    expect(await pollDeviceCode(device.deviceCode)).toEqual({ status: 'slow_down' });
  });

  it('approval flips the device code to consumed so it mints exactly one token set', async () => {
    const { app } = await newApp();
    const device = await createDeviceCode({ appId: app.id, scopes: ['documents:read'] });

    const approved = await approveDeviceCode(device.userCode, userId, workspaceId);
    expect(approved?.status).toBe('approved');
    expect(approved?.user_id).toBe(userId);

    const poll = await pollDeviceCode(device.deviceCode);
    expect(poll?.status).toBe('approved');
    expect(poll && 'row' in poll && poll.row.status).toBe('consumed');

    // Backdate the poll stamp so the second attempt is refused for being
    // already-consumed, not merely for being too fast.
    await pool.query(
      `UPDATE oauth_device_codes SET last_polled_at = NOW() - INTERVAL '1 hour'
        WHERE device_code_hash = $1`,
      [sha256Hex(device.deviceCode)]
    );
    expect(await pollDeviceCode(device.deviceCode)).toBeNull();
  });

  it('a denied device code polls as denied', async () => {
    const { app } = await newApp();
    const device = await createDeviceCode({ appId: app.id, scopes: ['documents:read'] });

    expect(await denyDeviceCode(device.userCode)).not.toBeNull();
    expect(await pollDeviceCode(device.deviceCode)).toEqual({ status: 'denied' });
    // A denied code cannot be resurrected by approving it afterwards.
    expect(await approveDeviceCode(device.userCode, userId, workspaceId)).toBeNull();
  });

  it('an expired device code polls as expired and is marked expired', async () => {
    const { app } = await newApp();
    const device = await createDeviceCode({ appId: app.id, scopes: ['documents:read'] });

    await pool.query(
      `UPDATE oauth_device_codes SET expires_at = NOW() - INTERVAL '1 second'
        WHERE device_code_hash = $1`,
      [sha256Hex(device.deviceCode)]
    );

    expect(await pollDeviceCode(device.deviceCode)).toEqual({ status: 'expired' });
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM oauth_device_codes WHERE device_code_hash = $1`,
      [sha256Hex(device.deviceCode)]
    );
    expect(row.rows[0]!.status).toBe('expired');
    // An expired code can no longer be approved by a human either.
    expect(await approveDeviceCode(device.userCode, userId, workspaceId)).toBeNull();
  });

  it('pollDeviceCode returns null for an unknown device code', async () => {
    expect(await pollDeviceCode('ship_dc_nope')).toBeNull();
  });

  // ── Token issuance ────────────────────────────────────────────────────────

  it('issueTokens writes an OAuth-tagged api_tokens row plus a refresh token', async () => {
    const { app } = await newApp();
    const tokens = await issueTokens({
      appId: app.id,
      userId,
      workspaceId,
      scopes: ['documents:read'],
    });

    expect(tokens.accessToken.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(tokens.accessToken.slice(ACCESS_TOKEN_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.refreshToken!.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(tokens.expiresIn).toBe(3600);

    const access = await pool.query<{
      oauth_app_id: string;
      scopes: string[];
      refresh_family_id: string;
      name: string;
      expires_at: Date;
      token_prefix: string;
    }>(
      `SELECT oauth_app_id, scopes, refresh_family_id, name, expires_at, token_prefix
         FROM api_tokens WHERE token_hash = $1`,
      [sha256Hex(tokens.accessToken)]
    );
    const row = access.rows[0]!;
    expect(row.oauth_app_id).toBe(app.id);
    expect(row.scopes).toEqual(['documents:read']);
    expect(row.refresh_family_id).toBe(tokens.familyId);
    // Generated name satisfies UNIQUE(user_id, workspace_id, name).
    expect(row.name.startsWith(`oauth:${app.client_id}:`)).toBe(true);
    const ttl = (row.expires_at.getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3605);

    const refresh = await pool.query<{ family_id: string; expires_at: Date }>(
      `SELECT family_id, expires_at FROM oauth_refresh_tokens WHERE token_hash = $1`,
      [sha256Hex(tokens.refreshToken!)]
    );
    expect(refresh.rows[0]!.family_id).toBe(tokens.familyId);
    const refreshDays = (refresh.rows[0]!.expires_at.getTime() - Date.now()) / 86_400_000;
    expect(refreshDays).toBeGreaterThan(29);
    expect(refreshDays).toBeLessThanOrEqual(30.1);
  });

  it('issueTokens can suppress the refresh token (client_credentials shape)', async () => {
    const { app } = await newApp();
    const tokens = await issueTokens({
      appId: app.id,
      userId,
      workspaceId,
      scopes: ['documents:read'],
      issueRefreshToken: false,
    });

    expect(tokens.refreshToken).toBeNull();
    const refresh = await pool.query(
      `SELECT 1 FROM oauth_refresh_tokens WHERE family_id = $1`,
      [tokens.familyId]
    );
    expect(refresh.rows).toHaveLength(0);
  });

  it('two issued access tokens for the same user and workspace do not collide', async () => {
    const { app } = await newApp();
    const a = await issueTokens({ appId: app.id, userId, workspaceId, scopes: ['documents:read'] });
    const b = await issueTokens({ appId: app.id, userId, workspaceId, scopes: ['documents:read'] });
    expect(a.accessToken).not.toBe(b.accessToken);
    expect(a.familyId).not.toBe(b.familyId);
  });

  // ── Refresh rotation ──────────────────────────────────────────────────────

  it('rotateRefreshToken issues a new pair inside the same family', async () => {
    const { app } = await newApp();
    const first = await issueTokens({
      appId: app.id,
      userId,
      workspaceId,
      scopes: ['documents:read'],
    });

    const rotated = await rotateRefreshToken(first.refreshToken!);
    expect(rotated).not.toBeNull();
    expect(rotated!.reused).toBe(false);
    const next = (rotated as { reused: false; tokens: typeof first }).tokens;

    expect(next.familyId).toBe(first.familyId);
    expect(next.refreshToken).not.toBe(first.refreshToken);
    expect(next.scopes).toEqual(['documents:read']);

    const old = await pool.query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM oauth_refresh_tokens WHERE token_hash = $1`,
      [sha256Hex(first.refreshToken!)]
    );
    expect(old.rows[0]!.consumed_at).not.toBeNull();
  });

  it('replaying a consumed refresh token revokes the whole family, access tokens included', async () => {
    const { app } = await newApp();
    const gen1 = await issueTokens({
      appId: app.id,
      userId,
      workspaceId,
      scopes: ['documents:read'],
    });
    const rotated = await rotateRefreshToken(gen1.refreshToken!);
    const gen2 = (rotated as { reused: false; tokens: typeof gen1 }).tokens;

    // The attacker (or the confused client) replays the spent token.
    const replay = await rotateRefreshToken(gen1.refreshToken!);
    expect(replay).toEqual({ reused: true });

    const refreshRows = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM oauth_refresh_tokens WHERE family_id = $1`,
      [gen1.familyId]
    );
    expect(refreshRows.rows).toHaveLength(2);
    for (const row of refreshRows.rows) expect(row.revoked_at).not.toBeNull();

    // Descendant access tokens die too — otherwise a thief keeps API access
    // for up to an hour after we detected the theft.
    const accessRows = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM api_tokens WHERE refresh_family_id = $1`,
      [gen1.familyId]
    );
    expect(accessRows.rows).toHaveLength(2);
    for (const row of accessRows.rows) expect(row.revoked_at).not.toBeNull();

    // And the still-live generation-2 token is now dead as well.
    expect(await rotateRefreshToken(gen2.refreshToken!)).toBeNull();
  });

  // Regression (security scan, LOW / CWE-613). Deactivating an app must cut off
  // its token-issuance channel, not just its access tokens. The refresh grant
  // used to reissue regardless of the app's active flag, so a "deleted" app kept
  // minting fresh credentials off an outstanding refresh token.
  it('refuses to rotate a refresh token once the app is deactivated', async () => {
    const { app } = await newApp();
    const first = await issueTokens({
      appId: app.id,
      userId,
      workspaceId,
      scopes: ['documents:read'],
    });

    // The app is deleted/deactivated in the portal.
    await pool.query('UPDATE oauth_apps SET active = false WHERE id = $1', [app.id]);

    // The refresh grant now refuses — no fresh credentials for a dead app.
    expect(await rotateRefreshToken(first.refreshToken!)).toBeNull();

    // …and the whole family is revoked, so no sibling can rotate either.
    const rows = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM oauth_refresh_tokens WHERE family_id = $1`,
      [first.familyId]
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) expect(row.revoked_at).not.toBeNull();
  });

  it('rotateRefreshToken returns null for unknown and expired tokens', async () => {
    const { app } = await newApp();
    expect(await rotateRefreshToken('ship_rt_unknown')).toBeNull();

    const tokens = await issueTokens({
      appId: app.id,
      userId,
      workspaceId,
      scopes: ['documents:read'],
    });
    await pool.query(
      `UPDATE oauth_refresh_tokens SET expires_at = NOW() - INTERVAL '1 second'
        WHERE token_hash = $1`,
      [sha256Hex(tokens.refreshToken!)]
    );
    expect(await rotateRefreshToken(tokens.refreshToken!)).toBeNull();
  });

  describe('contract audit #4 — concurrent replay cannot leave live credentials behind', () => {
    it('revokes the family even when the winner is mid-issuance', async () => {
      const app = await registerApp({
        workspaceId,
        ownerUserId: userId,
        name: `Race App ${crypto.randomUUID()}`,
        redirectUris: ['https://race.test/cb'],
        requestedScopes: ['documents:read'],
      });

      const first = await issueTokens({
        appId: app.app.id,
        userId,
        workspaceId,
        scopes: ['documents:read'],
      });

      // Both callers present the SAME refresh token at the same instant: one
      // claims it and issues, the other detects replay and revokes the family.
      const [a, b] = await Promise.all([
        rotateRefreshToken(first.refreshToken!),
        rotateRefreshToken(first.refreshToken!),
      ]);

      const outcomes = [a, b];
      expect(outcomes.filter((r) => r?.reused === true).length).toBeGreaterThanOrEqual(1);

      // Whatever the interleaving, NOTHING in this family may remain usable.
      const liveRefresh = await pool.query(
        `SELECT count(*)::int AS n FROM oauth_refresh_tokens
          WHERE family_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL`,
        [first.familyId]
      );
      const liveAccess = await pool.query(
        `SELECT count(*)::int AS n FROM api_tokens
          WHERE refresh_family_id = $1 AND revoked_at IS NULL`,
        [first.familyId]
      );
      expect(liveRefresh.rows[0].n).toBe(0);
      expect(liveAccess.rows[0].n).toBe(0);
    });
  });
});
