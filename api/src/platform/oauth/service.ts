/**
 * OAuth 2.0 authorization server core (Week 6, "PlugForge").
 *
 * Schema: api/src/db/migrations/039_platform_oauth.sql.
 *
 * Three invariants drive every function in this file:
 *
 *  1. NOTHING SECRET IS STORED. Client secrets, authorization codes, device
 *     codes, refresh tokens and access tokens are all handed out once in raw
 *     form and persisted only as sha256 hex — the same hash-then-lookup path
 *     api_tokens already uses, so there is exactly one bearer verification
 *     story in the codebase.
 *
 *  2. ONE-TIME-CONSUME IS THE DATABASE'S JOB, NOT THE CALLER'S. Authorization
 *     codes are redeemed with `DELETE ... WHERE ... RETURNING` (the pattern
 *     from services/oauth-state.ts); device codes and refresh tokens flip
 *     state inside a single conditional `UPDATE ... RETURNING`. A read-then-
 *     write in application code would let two concurrent redemptions of the
 *     same code both win; a conditional UPDATE cannot.
 *
 *  3. STOLEN REFRESH TOKENS ARE DETECTED, NOT JUST REJECTED. Refresh tokens
 *     rotate, and every rotation chain carries a family_id. Presenting an
 *     already-consumed refresh token is proof that either the client or the
 *     attacker is replaying, and we cannot tell which — so the entire family
 *     dies, access tokens included (RFC 6819 §5.2.2.3 / the OAuth 2.1 BCP).
 *
 * Access tokens are rows in api_tokens with oauth_app_id set. Migration 039's
 * header explains the consequence: the internal auth middleware filters
 * `oauth_app_id IS NULL`, so a scoped public token can never reach an
 * unscoped internal route.
 */
import crypto from 'node:crypto';
import { pool } from '../../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Token shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Prefix tags. Every credential is self-describing so a leaked string found
 *  in a log can be classified (and revoked) without guessing what it is. */
export const CLIENT_ID_PREFIX = 'ship_app_';
export const CLIENT_SECRET_PREFIX = 'ship_sec_';
export const AUTHORIZATION_CODE_PREFIX = 'ship_ac_';
export const DEVICE_CODE_PREFIX = 'ship_dc_';
export const ACCESS_TOKEN_PREFIX = 'ship_';
export const REFRESH_TOKEN_PREFIX = 'ship_rt_';

export const AUTHORIZATION_CODE_TTL_MINUTES = 10;
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_DAYS = 30;
export const DEVICE_CODE_TTL_SECONDS = 900;
export const DEVICE_CODE_POLL_INTERVAL_SECONDS = 5;

/**
 * User-code alphabet: A–Z and 2–9 with the six visually ambiguous letters
 * removed (B/8, I/1, L/1, O/0, S/5, Z/2). The digits 0 and 1 are already out
 * of the 2–9 range, so after dropping those letters no pair in this set can be
 * confused when a human reads a code off one screen and types it into another
 * — which is the entire ergonomic point of the device grant.
 * 28 symbols ^ 8 characters ≈ 3.8e11 codes.
 */
export const USER_CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY23456789';
export const USER_CODE_LENGTH = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Row types
//
// These are `type` aliases rather than `interface`s on purpose: pg's
// `QueryResultRow` is an index-signature type, and TypeScript grants implicit
// index signatures to type aliases but not to interfaces. `pool.query<Row>()`
// simply does not compile with an interface here.
// ─────────────────────────────────────────────────────────────────────────────

export type OAuthAppRow = {
  id: string;
  workspace_id: string | null;
  owner_user_id: string | null;
  name: string;
  client_id: string;
  client_secret_hash: string;
  client_secret_prefix: string;
  redirect_uris: string[];
  requested_scopes: string[];
  is_first_party: boolean;
  active: boolean;
  orphaned: boolean;
  created_at: Date;
  secret_rotated_at: Date | null;
};

export type AuthorizationCodeRow = {
  id: string;
  code_hash: string;
  app_id: string;
  user_id: string;
  workspace_id: string;
  redirect_uri: string;
  scopes: string[];
  code_challenge: string;
  code_challenge_method: string;
  expires_at: Date;
  created_at: Date;
};

export type DeviceCodeStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';

export type DeviceCodeRow = {
  id: string;
  device_code_hash: string;
  user_code: string;
  app_id: string;
  scopes: string[];
  status: DeviceCodeStatus;
  user_id: string | null;
  workspace_id: string | null;
  poll_interval_seconds: number;
  last_polled_at: Date | null;
  expires_at: Date;
  created_at: Date;
};

export type RefreshTokenRow = {
  id: string;
  token_hash: string;
  family_id: string;
  app_id: string;
  user_id: string;
  workspace_id: string;
  scopes: string[];
  consumed_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
  created_at: Date;
};

const APP_COLUMNS = `id, workspace_id, owner_user_id, name, client_id, client_secret_hash,
  client_secret_prefix, redirect_uris, requested_scopes, is_first_party, active, orphaned,
  created_at, secret_rotated_at`;

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** sha256 hex — the single hashing function for every credential here. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Length-safe constant-time string compare. `timingSafeEqual` throws on
 * length mismatch, and the length of a hex digest is public, so the early
 * return leaks nothing an attacker did not already know.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Random string over an explicit alphabet, rejection-free via randomInt. */
function randomFromAlphabet(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet.charAt(crypto.randomInt(alphabet.length));
  }
  return out;
}

/** Human-facing device code, rendered `XXXX-XXXX`. */
export function formatUserCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Accept whatever the human typed — lowercase, missing dash, stray spaces —
 * and produce the canonical stored form. Rejecting a correct code because the
 * user omitted the hyphen is a support ticket, not a security control.
 */
export function normalizeUserCode(input: string): string {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return stripped.length === USER_CODE_LENGTH ? formatUserCode(stripped) : stripped;
}

// ─────────────────────────────────────────────────────────────────────────────
// App registration
// ─────────────────────────────────────────────────────────────────────────────

export interface RegisterAppInput {
  workspaceId: string;
  ownerUserId: string;
  name: string;
  redirectUris: string[];
  requestedScopes: string[];
  /** First-party apps may use the client_credentials grant. Default false. */
  isFirstParty?: boolean;
}

export interface RegisterAppResult {
  app: OAuthAppRow;
  /** Shown exactly once. Only the sha256 is persisted. */
  rawClientSecret: string;
}

function generateClientSecret(): { raw: string; hash: string; prefix: string } {
  const raw = `${CLIENT_SECRET_PREFIX}${randomHex(32)}`;
  return {
    raw,
    hash: sha256Hex(raw),
    // The 8 identifying characters, i.e. the first 8 of the random body. The
    // literal first 8 characters of the string are `ship_sec` for every app
    // ever issued, which identifies nothing.
    prefix: raw.slice(CLIENT_SECRET_PREFIX.length, CLIENT_SECRET_PREFIX.length + 8),
  };
}

export async function registerApp(input: RegisterAppInput): Promise<RegisterAppResult> {
  const clientId = `${CLIENT_ID_PREFIX}${randomHex(8)}`;
  const secret = generateClientSecret();

  const result = await pool.query<OAuthAppRow>(
    `INSERT INTO oauth_apps
       (workspace_id, owner_user_id, name, client_id, client_secret_hash,
        client_secret_prefix, redirect_uris, requested_scopes, is_first_party)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${APP_COLUMNS}`,
    [
      input.workspaceId,
      input.ownerUserId,
      input.name,
      clientId,
      secret.hash,
      secret.prefix,
      input.redirectUris,
      input.requestedScopes,
      input.isFirstParty ?? false,
    ]
  );

  const app = result.rows[0];
  if (!app) throw new Error('registerApp: insert returned no row');
  return { app, rawClientSecret: secret.raw };
}

/**
 * Replace an app's secret. The old secret stops working the instant this
 * commits — there is deliberately no grace window, because a rotation is
 * usually a response to a leak and a grace window is exactly the thing an
 * attacker with the leaked secret needs.
 */
export async function rotateAppSecret(appId: string): Promise<{ rawClientSecret: string } | null> {
  const secret = generateClientSecret();
  const result = await pool.query<{ id: string }>(
    `UPDATE oauth_apps
        SET client_secret_hash = $2, client_secret_prefix = $3, secret_rotated_at = NOW()
      WHERE id = $1
      RETURNING id`,
    [appId, secret.hash, secret.prefix]
  );
  if (result.rows.length === 0) return null;
  return { rawClientSecret: secret.raw };
}

export async function getAppByClientId(clientId: string): Promise<OAuthAppRow | null> {
  const result = await pool.query<OAuthAppRow>(
    `SELECT ${APP_COLUMNS} FROM oauth_apps WHERE client_id = $1 AND active = true`,
    [clientId]
  );
  return result.rows[0] ?? null;
}

export async function getAppById(appId: string): Promise<OAuthAppRow | null> {
  const result = await pool.query<OAuthAppRow>(
    `SELECT ${APP_COLUMNS} FROM oauth_apps WHERE id = $1`,
    [appId]
  );
  return result.rows[0] ?? null;
}

/** Confidential-client authentication: sha256 compare against the stored hash. */
export async function authenticateApp(
  clientId: string,
  rawSecret: string
): Promise<OAuthAppRow | null> {
  const app = await getAppByClientId(clientId);
  if (!app) return null;
  if (!constantTimeEquals(sha256Hex(rawSecret), app.client_secret_hash)) return null;
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization codes (Authorization Code + PKCE)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateAuthorizationCodeInput {
  appId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
}

export async function createAuthorizationCode(
  input: CreateAuthorizationCodeInput
): Promise<string> {
  const raw = `${AUTHORIZATION_CODE_PREFIX}${randomHex(24)}`;
  await pool.query(
    `INSERT INTO oauth_authorization_codes
       (code_hash, app_id, user_id, workspace_id, redirect_uri, scopes,
        code_challenge, code_challenge_method, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + make_interval(mins => $9::int))`,
    [
      sha256Hex(raw),
      input.appId,
      input.userId,
      input.workspaceId,
      input.redirectUri,
      input.scopes,
      input.codeChallenge,
      input.codeChallengeMethod,
      AUTHORIZATION_CODE_TTL_MINUTES,
    ]
  );
  return raw;
}

/**
 * Redeem an authorization code. DELETE...RETURNING makes redemption and
 * invalidation the same atomic act, so a replayed code finds nothing to
 * delete — there is no window in which two exchanges can both succeed.
 *
 * Note that the code is burned even when a later check (PKCE, redirect_uri)
 * subsequently fails. That is intended: a failed exchange is either a bug or
 * an attack, and neither deserves a second attempt at the same code.
 */
export async function consumeAuthorizationCode(
  rawCode: string
): Promise<AuthorizationCodeRow | null> {
  const result = await pool.query<AuthorizationCodeRow>(
    `DELETE FROM oauth_authorization_codes
      WHERE code_hash = $1 AND expires_at > NOW()
      RETURNING *`,
    [sha256Hex(rawCode)]
  );
  return result.rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PKCE (RFC 7636)
// ─────────────────────────────────────────────────────────────────────────────

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeVerifier(verifier: string): boolean {
  return CODE_VERIFIER_PATTERN.test(verifier);
}

/** RFC 7636 §4.2: challenge = BASE64URL(SHA256(ASCII(verifier))). */
export function deriveCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * S256 only. `plain` is permitted by RFC 7636 but offers no protection against
 * the interception attack PKCE exists to stop, and OAuth 2.1 drops it — so the
 * schema CHECK constraint and this function both refuse it outright.
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier)) return false;
  if (!challenge) return false;
  return constantTimeEquals(deriveCodeChallenge(verifier), challenge);
}

// ─────────────────────────────────────────────────────────────────────────────
// Device authorization grant (RFC 8628)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateDeviceCodeInput {
  appId: string;
  scopes: string[];
}

export interface CreateDeviceCodeResult {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export async function createDeviceCode(
  input: CreateDeviceCodeInput
): Promise<CreateDeviceCodeResult> {
  const deviceCode = `${DEVICE_CODE_PREFIX}${randomHex(24)}`;

  // user_code is UNIQUE and short enough that a collision with a live code is
  // possible-if-rare; retry rather than surfacing a 500 to the device.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const userCode = formatUserCode(randomFromAlphabet(USER_CODE_ALPHABET, USER_CODE_LENGTH));
    try {
      await pool.query(
        `INSERT INTO oauth_device_codes
           (device_code_hash, user_code, app_id, scopes, poll_interval_seconds, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6::int))`,
        [
          sha256Hex(deviceCode),
          userCode,
          input.appId,
          input.scopes,
          DEVICE_CODE_POLL_INTERVAL_SECONDS,
          DEVICE_CODE_TTL_SECONDS,
        ]
      );
      return {
        deviceCode,
        userCode,
        expiresIn: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_CODE_POLL_INTERVAL_SECONDS,
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err; // not a unique violation — real failure
    }
  }
  throw new Error('createDeviceCode: could not allocate a unique user code');
}

/**
 * Bind a pending device code to the human who just approved it. Conditional
 * on `status = 'pending'`, so approving an already-denied or already-consumed
 * code is a no-op returning null rather than a resurrection.
 */
export async function approveDeviceCode(
  userCode: string,
  userId: string,
  workspaceId: string
): Promise<DeviceCodeRow | null> {
  const result = await pool.query<DeviceCodeRow>(
    `UPDATE oauth_device_codes
        SET status = 'approved', user_id = $2, workspace_id = $3
      WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW()
      RETURNING *`,
    [normalizeUserCode(userCode), userId, workspaceId]
  );
  return result.rows[0] ?? null;
}

export async function denyDeviceCode(userCode: string): Promise<DeviceCodeRow | null> {
  const result = await pool.query<DeviceCodeRow>(
    `UPDATE oauth_device_codes
        SET status = 'denied'
      WHERE user_code = $1 AND status = 'pending'
      RETURNING *`,
    [normalizeUserCode(userCode)]
  );
  return result.rows[0] ?? null;
}

export type DevicePollResult =
  | { status: 'authorization_pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'approved'; row: DeviceCodeRow };

type PollUpdateRow = DeviceCodeRow & { too_soon: boolean };

/**
 * One poll from the device.
 *
 * The rate check and the rate stamp are ONE statement. Splitting them into
 * `SELECT last_polled_at` then `UPDATE last_polled_at` would let a device that
 * fires two requests in parallel read the same stale timestamp twice and slip
 * past slow_down entirely — the CTE captures the pre-update value and the
 * UPDATE stamps the new one under the same row lock.
 *
 * Approval is likewise a conditional flip to 'consumed', so exactly one poll
 * of an approved device code can ever mint a token set. A device that retries
 * after a dropped response gets invalid_grant, not a second pair of tokens.
 */
export async function pollDeviceCode(rawDeviceCode: string): Promise<DevicePollResult | null> {
  const polled = await pool.query<PollUpdateRow>(
    `WITH prev AS (
       SELECT id, last_polled_at FROM oauth_device_codes WHERE device_code_hash = $1
     )
     UPDATE oauth_device_codes d
        SET last_polled_at = NOW()
       FROM prev
      WHERE d.id = prev.id
      RETURNING d.*,
        (prev.last_polled_at IS NOT NULL
         AND prev.last_polled_at > NOW() - make_interval(secs => d.poll_interval_seconds))
        AS too_soon`,
    [sha256Hex(rawDeviceCode)]
  );

  const row = polled.rows[0];
  if (!row) return null; // unknown device code

  if (row.status === 'denied') return { status: 'denied' };
  if (row.status === 'consumed') return null; // already minted its one token set
  if (row.status === 'expired') return { status: 'expired' };

  if (row.expires_at.getTime() <= Date.now()) {
    await pool.query(
      `UPDATE oauth_device_codes SET status = 'expired'
        WHERE id = $1 AND status IN ('pending', 'approved')`,
      [row.id]
    );
    return { status: 'expired' };
  }

  // Terminal answers are always delivered; only live polling is throttled.
  if (row.too_soon) return { status: 'slow_down' };

  if (row.status === 'pending') return { status: 'authorization_pending' };

  const consumed = await pool.query<DeviceCodeRow>(
    `UPDATE oauth_device_codes SET status = 'consumed'
      WHERE id = $1 AND status = 'approved'
      RETURNING *`,
    [row.id]
  );
  const consumedRow = consumed.rows[0];
  if (!consumedRow) return null; // lost the race to a concurrent poll
  return { status: 'approved', row: consumedRow };
}

// ─────────────────────────────────────────────────────────────────────────────
// Token issuance
// ─────────────────────────────────────────────────────────────────────────────

export interface IssueTokensInput {
  appId: string;
  userId: string;
  workspaceId: string;
  scopes: string[];
  /** Continue an existing rotation chain. Omit to start a new family. */
  familyId?: string;
  /** client_credentials issues no refresh token (RFC 6749 §4.4.3). */
  issueRefreshToken?: boolean;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string | null;
  familyId: string;
  scopes: string[];
  expiresIn: number;
}

/**
 * Mint an access token (a row in api_tokens, tagged with oauth_app_id) and,
 * unless suppressed, its paired refresh token. Both inserts share one
 * transaction: an access token with no recorded refresh token would strand the
 * client at the one-hour mark with no way back.
 */
/** Thrown when a family is revoked mid-issuance (concurrent replay). The
 * token route maps this to the same `invalid_grant` a sequential replay gets. */
export class RefreshFamilyRevokedError extends Error {
  constructor(public readonly familyId: string) {
    super(`Refresh token family ${familyId} was revoked during issuance`);
    this.name = 'RefreshFamilyRevokedError';
  }
}

export async function issueTokens(input: IssueTokensInput): Promise<IssuedTokens> {
  const app = await getAppById(input.appId);
  if (!app) throw new Error(`issueTokens: unknown app ${input.appId}`);

  const familyId = input.familyId ?? crypto.randomUUID();
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomHex(32)}`;
  const wantsRefresh = input.issueRefreshToken !== false;
  const refreshToken = wantsRefresh ? `${REFRESH_TOKEN_PREFIX}${randomHex(32)}` : null;

  // api_tokens carries UNIQUE(user_id, workspace_id, name); OAuth mints many
  // tokens for the same triple, so the name must be generated (migration 039's
  // note names this exact hazard).
  const tokenName = `oauth:${app.client_id}:${crypto.randomUUID()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO api_tokens
         (user_id, workspace_id, name, token_hash, token_prefix, expires_at,
          oauth_app_id, scopes, refresh_family_id)
       VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6::int), $7, $8, $9)`,
      [
        input.userId,
        input.workspaceId,
        tokenName,
        sha256Hex(accessToken),
        accessToken.slice(0, 12),
        ACCESS_TOKEN_TTL_SECONDS,
        input.appId,
        input.scopes,
        familyId,
      ]
    );

    if (refreshToken) {
      await client.query(
        `INSERT INTO oauth_refresh_tokens
           (token_hash, family_id, app_id, user_id, workspace_id, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(days => $7::int))`,
        [
          sha256Hex(refreshToken),
          familyId,
          input.appId,
          input.userId,
          input.workspaceId,
          input.scopes,
          REFRESH_TOKEN_TTL_DAYS,
        ]
      );
    }

    // Last-moment re-check against a concurrent family revocation.
    //
    // Rotation claims the old token in one statement, then issues here in a
    // SEPARATE transaction. That leaves a window: if a stolen token is
    // presented twice at once, the winner can be mid-issuance while the loser
    // detects reuse and revokes the family. The revocation sweep cannot see
    // rows this transaction has not committed, so the attacker's fresh tokens
    // would SURVIVE a revocation the victim was already told had happened --
    // exactly the attack family invalidation exists to stop. Re-reading inside
    // our own transaction closes it: if anything in this family was revoked
    // while we worked, abort and let the caller report reuse.
    // Found by the contract audit.
    if (input.familyId) {
      const revoked = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM oauth_refresh_tokens
          WHERE family_id = $1 AND revoked_at IS NOT NULL`,
        [familyId]
      );
      if (Number(revoked.rows[0]?.n ?? '0') > 0) {
        await client.query('ROLLBACK');
        throw new RefreshFamilyRevokedError(familyId);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    accessToken,
    refreshToken,
    familyId,
    scopes: input.scopes,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh rotation + family revocation
// ─────────────────────────────────────────────────────────────────────────────

export type RotateRefreshResult =
  | { reused: true }
  | { reused: false; tokens: IssuedTokens };

/**
 * Revoke an entire rotation chain: every refresh token in the family AND every
 * access token minted from it. Killing only the refresh tokens would leave a
 * thief with a working access token for up to an hour, which defeats the point
 * of detecting the theft.
 */
export async function revokeRefreshFamily(familyId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE oauth_refresh_tokens SET revoked_at = NOW()
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId]
    );
    await client.query(
      `UPDATE api_tokens SET revoked_at = NOW()
        WHERE refresh_family_id = $1 AND revoked_at IS NULL`,
      [familyId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Exchange a refresh token for a new pair.
 *
 * Returns `{ reused: true }` when the presented token was already spent. That
 * is the stolen-token signal: the legitimate client and the attacker both hold
 * the same string and we cannot tell them apart, so the whole family is
 * revoked and both are forced back through the authorization flow.
 *
 * Returns null for unknown, revoked, or expired tokens — nothing to rotate and
 * nothing to infer.
 */
export async function rotateRefreshToken(rawToken: string): Promise<RotateRefreshResult | null> {
  const tokenHash = sha256Hex(rawToken);

  // Claim the token and mark it spent in one statement. Two concurrent
  // exchanges of the same valid token cannot both come back with a row, so
  // the loser is treated as a replay on its next attempt.
  const claimed = await pool.query<RefreshTokenRow>(
    `UPDATE oauth_refresh_tokens
        SET consumed_at = NOW()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > NOW()
      RETURNING *`,
    [tokenHash]
  );

  const claimedRow = claimed.rows[0];
  if (claimedRow) {
    try {
      const tokens = await issueTokens({
        appId: claimedRow.app_id,
        userId: claimedRow.user_id,
        workspaceId: claimedRow.workspace_id,
        scopes: claimedRow.scopes,
        familyId: claimedRow.family_id,
      });
      return { reused: false, tokens };
    } catch (err) {
      // A concurrent presentation of this same token detected replay and
      // revoked the family while we were issuing. Our tokens were rolled back;
      // report replay so the caller sees the same invalid_grant a sequential
      // replay produces, instead of walking away with live credentials in a
      // family the server has already reported as revoked.
      if (err instanceof RefreshFamilyRevokedError) {
        await revokeRefreshFamily(claimedRow.family_id);
        return { reused: true };
      }
      throw err;
    }
  }

  const existing = await pool.query<RefreshTokenRow>(
    `SELECT * FROM oauth_refresh_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  const row = existing.rows[0];
  if (!row) return null;

  if (row.consumed_at !== null) {
    await revokeRefreshFamily(row.family_id);
    return { reused: true };
  }

  // Revoked or expired: reject, but this is not evidence of replay.
  return null;
}
