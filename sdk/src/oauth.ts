/**
 * OAuth grant machinery: Device Grant (RFC 8628), Authorization Code + PKCE
 * (RFC 7636), Client Credentials, and refresh.
 *
 * This module is deliberately free of any dependency on http.ts — the token
 * endpoint speaks form-encoded bodies and its own error vocabulary, not the
 * /api/v1 JSON envelope, and it must work *before* there is a bearer token to
 * attach. http.ts imports from here (for refresh); nothing here imports back.
 *
 * Crypto uses the Web Crypto global (`globalThis.crypto`), present in Node 20+
 * and every browser, so the PKCE path works unchanged in the SPA demo. Only
 * webhook.ts reaches for node:crypto, and only because timingSafeEqual has no
 * Web Crypto equivalent.
 */
import { ShipError } from './errors.js';
import type { ITokenStore } from './token-store.js';
import type { Tokens } from './types.js';

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** OAuth endpoints live beside /api/v1, not inside it. */
export const OAUTH_TOKEN_PATH = '/oauth/token';
export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';
export const OAUTH_DEVICE_CODE_PATH = '/oauth/device/code';

export interface FormPostResult {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** POST an `application/x-www-form-urlencoded` body and parse the JSON reply. */
export async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  params: Record<string, string | undefined>
): Promise<FormPostResult> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) form.set(key, value);
  }

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
    });
  } catch (cause) {
    throw ShipError.network(cause);
  }

  let body: Record<string, unknown> = {};
  try {
    body = asRecord(await res.json());
  } catch {
    // A non-JSON body from the token endpoint is a protocol violation; treat
    // it as an empty envelope and let the status drive the error.
  }
  return { status: res.status, ok: res.ok, body };
}

/**
 * Turn a token-endpoint success body into stored Tokens.
 *
 * `previous` carries the refresh token forward when the server omits it —
 * some grants only rotate on demand — so a refresh that returns just an
 * access token does not silently log the user out on the next 401.
 */
export function tokensFromGrant(body: Record<string, unknown>, previous?: Tokens | null): Tokens {
  const accessToken = str(body, 'access_token');
  if (!accessToken) {
    throw new ShipError({
      kind: 'auth',
      code: 'invalid_token_response',
      message: 'Token endpoint returned no access_token',
      status: 0,
    });
  }
  const tokens: Tokens = { access_token: accessToken };
  const refreshToken = str(body, 'refresh_token') ?? previous?.refresh_token;
  if (refreshToken) tokens.refresh_token = refreshToken;
  const expiresIn = num(body, 'expires_in');
  if (expiresIn !== undefined) tokens.expires_at = Date.now() + expiresIn * 1000;
  return tokens;
}

/** Map an OAuth error envelope (`{error, error_description}`) to a ShipError. */
export function oauthError(status: number, body: Record<string, unknown>): ShipError {
  const code = str(body, 'error') ?? str(body, 'code') ?? 'oauth_error';
  const message =
    str(body, 'error_description') ??
    str(body, 'message') ??
    `OAuth token request failed with status ${status}`;
  // Every failure at the token endpoint is an auth failure from the
  // consumer's point of view, except a genuine 5xx.
  return new ShipError({
    kind: status >= 500 ? 'server' : 'auth',
    code,
    message,
    status,
    requestId: str(body, 'request_id') ?? '',
  });
}

// ── PKCE ────────────────────────────────────────────────────────────────────

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  // btoa exists in browsers and in Node 16+; Buffer is the Node fallback.
  const scope = globalThis as { btoa?: (input: string) => string };
  const b64 =
    typeof scope.btoa === 'function'
      ? scope.btoa(binary)
      : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomUrlSafeString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomUrlSafeString(32);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)), method: 'S256' };
}

// ── Device Grant (RFC 8628) ─────────────────────────────────────────────────

export interface DeviceFlowOptions {
  baseUrl: string;
  clientId: string;
  /** Called once, as soon as the user code exists. Print it; open the URL. */
  onUserCode: (code: string, verifyUrl: string) => void;
  scope?: string;
  fetchImpl: typeof fetch;
  /**
   * Test seam. Production passes nothing and gets a real timer; the suite
   * passes a recorder so it can assert that slow_down actually widened the
   * interval without waiting seconds of wall clock.
   */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** RFC 8628 §3.5: the mandated back-off step when the server says slow_down. */
const SLOW_DOWN_STEP_SECONDS = 5;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export async function runDeviceFlow(opts: DeviceFlowOptions): Promise<Tokens> {
  const sleep = opts.sleep ?? defaultSleep;

  const start = await postForm(opts.fetchImpl, `${opts.baseUrl}${OAUTH_DEVICE_CODE_PATH}`, {
    client_id: opts.clientId,
    scope: opts.scope,
  });
  if (!start.ok) throw oauthError(start.status, start.body);

  const deviceCode = str(start.body, 'device_code');
  const userCode = str(start.body, 'user_code');
  const verificationUri =
    str(start.body, 'verification_uri_complete') ?? str(start.body, 'verification_uri');
  if (!deviceCode || !userCode || !verificationUri) {
    throw new ShipError({
      kind: 'server',
      code: 'invalid_device_authorization_response',
      message: 'Device authorization response was missing device_code, user_code or verification_uri',
      status: start.status,
    });
  }

  opts.onUserCode(userCode, verificationUri);

  let intervalSeconds = num(start.body, 'interval') ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const expiresInSeconds = num(start.body, 'expires_in') ?? 600;
  const deadline = Date.now() + expiresInSeconds * 1000;

  for (;;) {
    // Wait first: polling the instant the code is issued is guaranteed to be
    // `authorization_pending` and only burns a rate-limit slot.
    await sleep(intervalSeconds * 1000);

    if (Date.now() > deadline) {
      throw new ShipError({
        kind: 'auth',
        code: 'expired_token',
        message: 'Device code expired before the user approved it',
        status: 0,
      });
    }

    const poll = await postForm(opts.fetchImpl, `${opts.baseUrl}${OAUTH_TOKEN_PATH}`, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: opts.clientId,
    });

    if (poll.ok) return tokensFromGrant(poll.body);

    const error = str(poll.body, 'error');
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalSeconds += SLOW_DOWN_STEP_SECONDS;
      continue;
    }
    throw oauthError(poll.status, poll.body);
  }
}

// ── Authorization Code + PKCE ───────────────────────────────────────────────

export interface AuthorizationCodeFlowOptions {
  baseUrl: string;
  clientId: string;
  /** Public clients (SPA, CLI) omit this — PKCE is the proof instead. */
  clientSecret?: string;
  redirectUri: string;
  scope?: string;
  /** Open this URL in a browser (or print it). */
  onAuthorizeUrl: (url: string, state: string) => void | Promise<void>;
  /** Resolve with the `code` (and `state`) the redirect delivered back. */
  waitForRedirect: (state: string) => Promise<{ code: string; state?: string }>;
  fetchImpl: typeof fetch;
}

export async function runAuthorizationCodeFlow(
  opts: AuthorizationCodeFlowOptions
): Promise<Tokens> {
  const pkce = await createPkcePair();
  const state = randomUrlSafeString(16);

  const authorizeUrl = new URL(`${opts.baseUrl}${OAUTH_AUTHORIZE_PATH}`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', opts.clientId);
  authorizeUrl.searchParams.set('redirect_uri', opts.redirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
  authorizeUrl.searchParams.set('code_challenge_method', pkce.method);
  if (opts.scope) authorizeUrl.searchParams.set('scope', opts.scope);

  await opts.onAuthorizeUrl(authorizeUrl.toString(), state);

  const redirect = await opts.waitForRedirect(state);
  // CSRF: a redirect carrying someone else's state is not our flow.
  if (redirect.state !== undefined && redirect.state !== state) {
    throw new ShipError({
      kind: 'auth',
      code: 'state_mismatch',
      message: 'Authorization redirect returned a state that does not match the request',
      status: 0,
    });
  }

  const result = await postForm(opts.fetchImpl, `${opts.baseUrl}${OAUTH_TOKEN_PATH}`, {
    grant_type: 'authorization_code',
    code: redirect.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code_verifier: pkce.verifier,
  });
  if (!result.ok) throw oauthError(result.status, result.body);
  return tokensFromGrant(result.body);
}

// ── Client Credentials ──────────────────────────────────────────────────────

export interface ClientCredentialsOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  fetchImpl: typeof fetch;
}

export async function runClientCredentials(opts: ClientCredentialsOptions): Promise<Tokens> {
  const result = await postForm(opts.fetchImpl, `${opts.baseUrl}${OAUTH_TOKEN_PATH}`, {
    grant_type: 'client_credentials',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    scope: opts.scope,
  });
  if (!result.ok) throw oauthError(result.status, result.body);
  return tokensFromGrant(result.body);
}

// ── Refresh ─────────────────────────────────────────────────────────────────

export interface RefreshOptions {
  baseUrl: string;
  fetchImpl: typeof fetch;
  tokenStore: ITokenStore;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Exchange the stored refresh token for a fresh pair. Returns null when there
 * is nothing to refresh with.
 *
 * On a 400/401 the refresh token is dead (rotated, revoked, or its family was
 * killed) — the store is cleared so the next call fails fast at "log in
 * again" instead of retrying a credential that can never work. A network
 * failure deliberately does NOT clear: a flaky connection must not log a
 * developer out.
 */
export async function refreshTokens(opts: RefreshOptions): Promise<Tokens | null> {
  const current = await opts.tokenStore.get();
  const refreshToken = current?.refresh_token;
  if (!refreshToken) return null;

  const result = await postForm(opts.fetchImpl, `${opts.baseUrl}${OAUTH_TOKEN_PATH}`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  if (!result.ok) {
    if (result.status === 400 || result.status === 401) {
      await opts.tokenStore.clear();
    }
    throw oauthError(result.status, result.body);
  }

  const next = tokensFromGrant(result.body, current);
  await opts.tokenStore.set(next);
  return next;
}
