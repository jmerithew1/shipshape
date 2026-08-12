/**
 * OAuth 2.0 protocol endpoints (Week 6, "PlugForge").
 *
 * Mounted at /oauth. Two families of endpoint live here and they authenticate
 * in completely different ways, which is why the session middleware is
 * INJECTED rather than imported:
 *
 *   - Human-facing (GET /authorize, POST /authorize/decision,
 *     POST /device/verify) run behind the browser session. They are the points
 *     where a person grants or refuses consent.
 *   - Machine-facing (POST /token, POST /device/code) are called by clients,
 *     never by a browser session, and authenticate with client credentials or
 *     with proof-of-possession (PKCE).
 *
 * Injecting `auth` keeps this router free of any dependency on the internal
 * session stack — the public surface may not import internal route handlers
 * (enforced by eslint's no-restricted-imports rule for api/src/platform/**),
 * and it lets tests drive the consent flow with a two-line fake.
 *
 * /authorize returns JSON consent CONTEXT rather than rendering an HTML
 * consent screen. The screen is the web app's job; this endpoint's job is to
 * validate the request and hand the UI exactly what it needs to describe the
 * grant honestly. That split is also what makes the whole consent flow
 * testable without a browser.
 */
import { Router } from 'express';
import type { Router as RouterType, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { scopeRegistry } from '../scopes/registry.js';
import { oauthError } from './errors.js';
import type { OAuthErrorCode } from './errors.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  authenticateApp,
  consumeAuthorizationCode,
  createAuthorizationCode,
  createDeviceCode,
  approveDeviceCode,
  denyDeviceCode,
  getAppByClientId,
  issueTokens,
  pollDeviceCode,
  rotateRefreshToken,
  verifyPkce,
} from './service.js';
import type { IssuedTokens, OAuthAppRow } from './service.js';

/** Where a human goes to type the user code shown on their device. */
export const DEVICE_VERIFICATION_URI = '/device';

export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** RFC 7636 §4.1 ABNF — code_challenge shares the code_verifier character set. */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

/**
 * Express 4 does not catch rejected promises from handlers. Without this
 * wrapper a thrown error becomes a hung request; with it, it becomes an
 * RFC-shaped server_error and a log line.
 */
function route(handler: AsyncHandler): RequestHandler {
  return (req, res) => {
    handler(req, res).catch((err: unknown) => {
      console.error('[oauth] unhandled error', err);
      if (!res.headersSent) oauthError(res, 500, 'server_error', 'Internal server error');
    });
  };
}

/** Form bodies carry booleans as strings; JSON bodies carry real booleans. */
function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return false;
}

function splitScopes(scope: string | undefined): string[] {
  if (!scope) return [];
  return scope.trim().split(/\s+/).filter((s) => s.length > 0);
}

/**
 * Append parameters WITHOUT re-serializing the registered redirect URI.
 * Running it through `new URL()` would normalise it (trailing slashes, default
 * ports, percent-encoding) and the client's own exact-match check against the
 * URI it registered would then fail.
 */
function appendParams(redirectUri: string, params: Record<string, string>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) qs.set(key, value);
  const separator = redirectUri.includes('?') ? '&' : '?';
  return `${redirectUri}${separator}${qs.toString()}`;
}

/** RFC 6749 §2.3.1 client authentication via the HTTP Basic scheme. */
function basicCredentials(req: Request): { clientId: string; clientSecret: string } | null {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('basic ')) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator)),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
  };
}

function sendTokens(res: Response, tokens: IssuedTokens): void {
  // RFC 6749 §5.1: token responses must never be cached.
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  const body: Record<string, unknown> = {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: tokens.scopes.join(' '),
  };
  if (tokens.refreshToken) body.refresh_token = tokens.refreshToken;
  res.status(200).json(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared authorization-request validation
// ─────────────────────────────────────────────────────────────────────────────

type ValidationFailure = {
  ok: false;
  status: number;
  error: OAuthErrorCode;
  description: string;
};

type AuthorizeValidation =
  | { ok: true; app: OAuthAppRow; scopes: string[] }
  | ValidationFailure;

function fail(error: OAuthErrorCode, description: string, status = 400): ValidationFailure {
  return { ok: false, status, error, description };
}

/**
 * Validate everything /authorize and /authorize/decision have in common.
 *
 * The decision endpoint re-runs this rather than trusting the parameters the
 * consent UI echoes back: the browser is not a trusted store, and a user who
 * edits `scope` in the POST body must not end up with a code for scopes the
 * app never requested.
 */
async function validateAuthorizeRequest(input: {
  clientId: string;
  redirectUri: string;
  scope?: string | undefined;
  codeChallenge: string;
  codeChallengeMethod: string;
}): Promise<AuthorizeValidation> {
  const app = await getAppByClientId(input.clientId);
  if (!app) return fail('invalid_client', 'Unknown or inactive client_id');

  // RFC 6749 §4.1.2.1: an unregistered redirect_uri must NOT be redirected to
  // — that is the open-redirect. Exact string match, no prefix matching.
  if (!app.redirect_uris.includes(input.redirectUri)) {
    return fail('invalid_request', 'redirect_uri does not exactly match a registered redirect URI');
  }

  if (input.codeChallengeMethod !== 'S256') {
    return fail('invalid_request', "code_challenge_method must be 'S256'");
  }
  if (!CODE_CHALLENGE_PATTERN.test(input.codeChallenge)) {
    return fail('invalid_request', 'code_challenge must be 43-128 unreserved characters');
  }

  // An omitted scope means "everything this app registered for", which is the
  // RFC's server-defined default and keeps the consent screen honest.
  const requested = splitScopes(input.scope);
  const scopes = requested.length > 0 ? requested : [...app.requested_scopes];

  const escalated = scopes.filter((s) => !app.requested_scopes.includes(s));
  if (escalated.length > 0) {
    return fail('invalid_scope', `Scope not registered for this app: ${escalated.join(', ')}`);
  }

  return { ok: true, app, scopes };
}

/** Consent context: what the UI needs to describe the grant to a human. */
function consentScopes(scopes: string[]): Array<{ scope: string; description: string }> {
  return scopes.map((scope) => ({
    scope,
    description: scopeRegistry.describe(scope) ?? scope,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const authorizeQuerySchema = z.object({
  response_type: z.string(),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string().min(1),
});

const decisionSchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string().min(1),
  approve: z.unknown(),
});

const deviceCodeSchema = z.object({
  client_id: z.string().min(1),
  scope: z.string().optional(),
});

const deviceVerifySchema = z.object({
  user_code: z.string().min(1),
  approve: z.unknown(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export function createOAuthRouter({ auth }: { auth: RequestHandler }): RouterType {
  const router: RouterType = Router();

  // ── GET /oauth/authorize ───────────────────────────────────────────────────
  router.get(
    '/authorize',
    auth,
    route(async (req, res) => {
      const parsed = authorizeQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        oauthError(res, 400, 'invalid_request', 'Missing or malformed authorization parameters');
        return;
      }
      const q = parsed.data;

      if (q.response_type !== 'code') {
        oauthError(res, 400, 'unsupported_response_type', "response_type must be 'code'");
        return;
      }

      const validation = await validateAuthorizeRequest({
        clientId: q.client_id,
        redirectUri: q.redirect_uri,
        scope: q.scope,
        codeChallenge: q.code_challenge,
        codeChallengeMethod: q.code_challenge_method,
      });
      if (!validation.ok) {
        oauthError(res, validation.status, validation.error, validation.description);
        return;
      }

      res.status(200).json({
        app_name: validation.app.name,
        client_id: validation.app.client_id,
        redirect_uri: q.redirect_uri,
        scopes: consentScopes(validation.scopes),
        state: q.state ?? null,
        code_challenge: q.code_challenge,
        code_challenge_method: q.code_challenge_method,
      });
    })
  );

  // ── POST /oauth/authorize/decision ─────────────────────────────────────────
  router.post(
    '/authorize/decision',
    auth,
    route(async (req, res) => {
      const parsed = decisionSchema.safeParse(req.body);
      if (!parsed.success) {
        oauthError(res, 400, 'invalid_request', 'Missing or malformed decision parameters');
        return;
      }
      const body = parsed.data;

      const validation = await validateAuthorizeRequest({
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        scope: body.scope,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method,
      });
      if (!validation.ok) {
        oauthError(res, validation.status, validation.error, validation.description);
        return;
      }

      if (!toBoolean(body.approve)) {
        const params: Record<string, string> = { error: 'access_denied' };
        if (body.state !== undefined) params.state = body.state;
        res.status(200).json({ redirect_to: appendParams(body.redirect_uri, params) });
        return;
      }

      const code = await createAuthorizationCode({
        appId: validation.app.id,
        userId: req.userId,
        workspaceId: req.workspaceId,
        redirectUri: body.redirect_uri,
        scopes: validation.scopes,
        codeChallenge: body.code_challenge,
        codeChallengeMethod: body.code_challenge_method,
      });

      const params: Record<string, string> = { code };
      if (body.state !== undefined) params.state = body.state;
      res.status(200).json({ redirect_to: appendParams(body.redirect_uri, params) });
    })
  );

  // ── POST /oauth/device/code ────────────────────────────────────────────────
  router.post(
    '/device/code',
    route(async (req, res) => {
      const parsed = deviceCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        oauthError(res, 400, 'invalid_request', 'client_id is required');
        return;
      }

      const app = await getAppByClientId(parsed.data.client_id);
      if (!app) {
        oauthError(res, 400, 'invalid_client', 'Unknown or inactive client_id');
        return;
      }

      const requested = splitScopes(parsed.data.scope);
      const scopes = requested.length > 0 ? requested : [...app.requested_scopes];
      const escalated = scopes.filter((s) => !app.requested_scopes.includes(s));
      if (escalated.length > 0) {
        oauthError(res, 400, 'invalid_scope', `Scope not registered for this app: ${escalated.join(', ')}`);
        return;
      }

      const device = await createDeviceCode({ appId: app.id, scopes });
      res.set('Cache-Control', 'no-store');
      res.status(200).json({
        device_code: device.deviceCode,
        user_code: device.userCode,
        verification_uri: DEVICE_VERIFICATION_URI,
        verification_uri_complete: `${DEVICE_VERIFICATION_URI}?user_code=${encodeURIComponent(device.userCode)}`,
        expires_in: device.expiresIn,
        interval: device.interval,
      });
    })
  );

  // ── POST /oauth/device/verify ──────────────────────────────────────────────
  router.post(
    '/device/verify',
    auth,
    route(async (req, res) => {
      const parsed = deviceVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        oauthError(res, 400, 'invalid_request', 'user_code is required');
        return;
      }

      if (!toBoolean(parsed.data.approve)) {
        const denied = await denyDeviceCode(parsed.data.user_code);
        if (!denied) {
          oauthError(res, 400, 'invalid_grant', 'Unknown, expired, or already-answered user code');
          return;
        }
        res.status(200).json({ user_code: denied.user_code, status: 'denied' });
        return;
      }

      const approved = await approveDeviceCode(
        parsed.data.user_code,
        req.userId,
        req.workspaceId
      );
      if (!approved) {
        oauthError(res, 400, 'invalid_grant', 'Unknown, expired, or already-answered user code');
        return;
      }
      res.status(200).json({
        user_code: approved.user_code,
        status: 'approved',
        scopes: approved.scopes,
      });
    })
  );

  // ── POST /oauth/token ──────────────────────────────────────────────────────
  router.post(
    '/token',
    route(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const grantType = typeof body.grant_type === 'string' ? body.grant_type : '';

      switch (grantType) {
        case 'authorization_code':
          await handleAuthorizationCodeGrant(body, res);
          return;
        case 'refresh_token':
          await handleRefreshTokenGrant(body, res);
          return;
        case DEVICE_CODE_GRANT_TYPE:
          await handleDeviceCodeGrant(body, res);
          return;
        case 'client_credentials':
          await handleClientCredentialsGrant(req, body, res);
          return;
        default:
          oauthError(res, 400, 'unsupported_grant_type', `Unsupported grant_type: '${grantType}'`);
          return;
      }
    })
  );

  return router;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grant handlers
// ─────────────────────────────────────────────────────────────────────────────

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Authorization Code + PKCE.
 *
 * Ship's authorization-code clients are PUBLIC clients (CLIs, SPAs, desktop
 * apps) — they cannot keep a secret, so no client secret is demanded here.
 * The code_verifier IS the proof: only the party that generated the verifier
 * behind the challenge can redeem the code, which is precisely the guarantee a
 * client secret would have provided and PKCE provides without shipping one.
 */
async function handleAuthorizationCodeGrant(
  body: Record<string, unknown>,
  res: Response
): Promise<void> {
  const code = str(body, 'code');
  const verifier = str(body, 'code_verifier');
  const clientId = str(body, 'client_id');
  const redirectUri = str(body, 'redirect_uri');

  if (!code || !verifier || !clientId || !redirectUri) {
    oauthError(
      res,
      400,
      'invalid_request',
      'code, code_verifier, client_id and redirect_uri are required'
    );
    return;
  }

  const app = await getAppByClientId(clientId);
  if (!app) {
    oauthError(res, 400, 'invalid_client', 'Unknown or inactive client_id');
    return;
  }

  // Burns the code whether or not the checks below pass — see
  // consumeAuthorizationCode. Expiry and replay are the same null here.
  const row = await consumeAuthorizationCode(code);
  if (!row) {
    oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used');
    return;
  }

  if (row.app_id !== app.id) {
    oauthError(res, 400, 'invalid_grant', 'Authorization code was not issued to this client');
    return;
  }
  if (row.redirect_uri !== redirectUri) {
    oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
    return;
  }
  if (!verifyPkce(verifier, row.code_challenge)) {
    oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
    return;
  }

  const tokens = await issueTokens({
    appId: row.app_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    scopes: row.scopes,
  });
  sendTokens(res, tokens);
}

async function handleRefreshTokenGrant(
  body: Record<string, unknown>,
  res: Response
): Promise<void> {
  const raw = str(body, 'refresh_token');
  if (!raw) {
    oauthError(res, 400, 'invalid_request', 'refresh_token is required');
    return;
  }

  const result = await rotateRefreshToken(raw);
  if (!result) {
    oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid, revoked, or expired');
    return;
  }
  if (result.reused) {
    // The whole family is already dead by the time we get here.
    oauthError(
      res,
      400,
      'invalid_grant',
      'Refresh token replay detected; the token family has been revoked'
    );
    return;
  }
  sendTokens(res, result.tokens);
}

/** RFC 8628 §3.5 — the polling state machine, verbatim. */
async function handleDeviceCodeGrant(
  body: Record<string, unknown>,
  res: Response
): Promise<void> {
  const deviceCode = str(body, 'device_code');
  const clientId = str(body, 'client_id');
  if (!deviceCode || !clientId) {
    oauthError(res, 400, 'invalid_request', 'device_code and client_id are required');
    return;
  }

  const app = await getAppByClientId(clientId);
  if (!app) {
    oauthError(res, 400, 'invalid_client', 'Unknown or inactive client_id');
    return;
  }

  const poll = await pollDeviceCode(deviceCode);
  if (!poll) {
    oauthError(res, 400, 'invalid_grant', 'Device code is invalid or has already been used');
    return;
  }

  switch (poll.status) {
    case 'authorization_pending':
      oauthError(res, 400, 'authorization_pending', 'The user has not yet approved this request');
      return;
    case 'slow_down':
      oauthError(res, 400, 'slow_down', 'Polling too frequently; increase the interval');
      return;
    case 'expired':
      oauthError(res, 400, 'expired_token', 'The device code has expired');
      return;
    case 'denied':
      oauthError(res, 400, 'access_denied', 'The user denied this request');
      return;
    case 'approved':
      break;
  }

  const row = poll.row;
  if (row.app_id !== app.id || !row.user_id || !row.workspace_id) {
    oauthError(res, 400, 'invalid_grant', 'Device code was not issued to this client');
    return;
  }

  const tokens = await issueTokens({
    appId: row.app_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    scopes: row.scopes,
  });
  sendTokens(res, tokens);
}

/**
 * client_credentials — machine-to-machine, no human in the loop.
 *
 * Restricted to first-party apps by design. A third-party app holding a
 * client_credentials token would be acting inside a workspace with no user
 * having ever consented to it, which is the one thing the whole consent flow
 * exists to prevent. Third parties get authorization_code or device grant.
 *
 * No refresh token is issued (RFC 6749 §4.4.3): the client already holds
 * credentials that mint a fresh access token on demand, so a refresh token
 * would be a second, longer-lived secret bought for nothing.
 */
async function handleClientCredentialsGrant(
  req: Request,
  body: Record<string, unknown>,
  res: Response
): Promise<void> {
  const basic = basicCredentials(req);
  const clientId = basic?.clientId ?? str(body, 'client_id');
  const clientSecret = basic?.clientSecret ?? str(body, 'client_secret');

  if (!clientId || !clientSecret) {
    oauthError(res, 400, 'invalid_request', 'client_id and client_secret are required');
    return;
  }

  const app = await authenticateApp(clientId, clientSecret);
  if (!app) {
    // RFC 6749 §5.2: 401 + WWW-Authenticate when the client used an HTTP
    // authentication scheme, 400 when the credentials were in the body.
    if (basic) {
      res.set('WWW-Authenticate', 'Basic realm="oauth"');
      oauthError(res, 401, 'invalid_client', 'Client authentication failed');
    } else {
      oauthError(res, 400, 'invalid_client', 'Client authentication failed');
    }
    return;
  }

  if (!app.is_first_party) {
    oauthError(
      res,
      400,
      'unauthorized_client',
      'client_credentials is restricted to first-party applications'
    );
    return;
  }

  if (!app.owner_user_id || !app.workspace_id) {
    oauthError(res, 400, 'invalid_client', 'Application has no owner to act as');
    return;
  }

  const requested = splitScopes(str(body, 'scope'));
  const scopes = requested.length > 0 ? requested : [...app.requested_scopes];
  const escalated = scopes.filter((s) => !app.requested_scopes.includes(s));
  if (escalated.length > 0) {
    oauthError(res, 400, 'invalid_scope', `Scope not registered for this app: ${escalated.join(', ')}`);
    return;
  }

  const tokens = await issueTokens({
    appId: app.id,
    userId: app.owner_user_id,
    workspaceId: app.workspace_id,
    scopes,
    issueRefreshToken: false,
  });
  sendTokens(res, tokens);
}
