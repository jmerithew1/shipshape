/**
 * TokenGate — bearer validation for every /api/v1 route (MVP gate A3).
 *
 * One validator, one revocation path: OAuth-issued access tokens are rows in
 * the SAME api_tokens table the internal API already trusts (migration 039),
 * so there is no second auth stack to drift. The split is directional:
 *   - internal authMiddleware accepts only oauth_app_id IS NULL (personal
 *     tokens), because it does not enforce scopes;
 *   - this gate accepts both, and enforces scopes on the OAuth ones.
 *
 * Failures go through next(ApiError) so the v1 error handler ships the one
 * public error envelope (code/message/details?/request_id).
 */
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { pool } from '../../../../db/client.js';
import { ApiError } from '../errors.js';
import { scopeRegistry } from '../../../scopes/registry.js';

export interface PlatformContext {
  tokenId: string;
  userId: string;
  workspaceId: string;
  isSuperAdmin: boolean;
  /** OAuth app's client_id, or null for a personal access token. */
  clientId: string | null;
  oauthAppId: string | null;
  grantedScopes: string[];
}

declare global {
  namespace Express {
    interface Request {
      /** Set by tokenGate on every authenticated /api/v1 request. */
      platform?: PlatformContext;
    }
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Mirrors the session path's throttle in api/src/middleware/auth.ts: an
 * unthrottled write here is one UPDATE per public request — the "auth tax"
 * hotspot the Part-1 audit measured, and public traffic multiplies it. */
const LAST_USED_WRITE_THRESHOLD_MS = 30 * 1000;

export async function tokenGate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers?.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(ApiError.unauthorized('Missing bearer token'));
    return;
  }

  const raw = authHeader.slice(7).trim();
  if (!raw) {
    next(ApiError.unauthorized('Missing bearer token'));
    return;
  }

  try {
    const result = await pool.query(
      `SELECT t.id, t.user_id, t.workspace_id, t.expires_at, t.revoked_at, t.last_used_at,
              t.oauth_app_id, t.scopes,
              u.is_super_admin,
              a.client_id, a.active AS app_active
         FROM api_tokens t
         JOIN users u ON t.user_id = u.id
         LEFT JOIN oauth_apps a ON t.oauth_app_id = a.id
        WHERE t.token_hash = $1`,
      [hashToken(raw)]
    );

    const row = result.rows[0];
    if (!row || row.revoked_at) {
      next(ApiError.unauthorized('Invalid token'));
      return;
    }

    // Expired tokens get a DISTINCT code so clients refresh instead of
    // restarting the whole login (graded requirement).
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      next(ApiError.tokenExpired());
      return;
    }

    // A deactivated app's outstanding tokens die with it.
    if (row.oauth_app_id && row.app_active === false) {
      next(ApiError.unauthorized('The OAuth app for this token is inactive'));
      return;
    }

    // Personal access tokens (no OAuth app) carry no scope column. They are
    // the resource owner acting as themselves, so they hold every scope —
    // scoping exists to constrain THIRD PARTIES acting on a user's behalf.
    const grantedScopes: string[] = row.oauth_app_id
      ? ((row.scopes as string[] | null) ?? [])
      : scopeRegistry.list();

    if (Date.now() - (row.last_used_at ? new Date(row.last_used_at).getTime() : 0) > LAST_USED_WRITE_THRESHOLD_MS) {
      await pool.query('UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1', [row.id]);
    }

    // Super-admin is an identity property, NOT a delegable one. If a
    // super-admin authorizes a third-party app, that app's token must not
    // inherit admin power — every internal authorization middleware
    // (superAdminMiddleware, workspaceAdminMiddleware, workspaceAccessMiddleware)
    // short-circuits on this flag, so inheriting it would silently hand full
    // admin to an app that was granted `documents:read`. Found by the security
    // audit before any v1 route depended on it.
    const isSuperAdmin = row.oauth_app_id ? false : row.is_super_admin;

    req.platform = {
      tokenId: row.id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      isSuperAdmin,
      clientId: row.client_id ?? null,
      oauthAppId: row.oauth_app_id ?? null,
      grantedScopes,
    };

    // Mirror onto the request fields the rest of the codebase reads.
    req.userId = row.user_id;
    req.workspaceId = row.workspace_id;
    req.isSuperAdmin = isSuperAdmin;

    next();
  } catch (err) {
    console.error(`[api/v1] token validation failed (request ${req.requestId}):`, err);
    next(ApiError.server('Authentication failed'));
  }
}
