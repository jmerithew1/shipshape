/**
 * OAuth app management (MVP gate A1) — the developer portal's backing routes.
 *
 * WHY THIS IS SESSION-AUTHENTICATED AND NOT A /api/v1 RESOURCE:
 * registering your first OAuth app is the bootstrap step. Gating it behind an
 * OAuth token would require a token you cannot obtain without an app — a
 * chicken-and-egg the whole industry solves the same way (Stripe, GitHub, and
 * Slack all manage app credentials from a session-authenticated dashboard,
 * not from their own public APIs). Everything the portal does AFTER
 * bootstrapping — reading documents, managing subscriptions — goes through
 * /api/v1 like any third-party client.
 *
 * The raw client secret is returned exactly once, on creation and on
 * rotation. It is never recoverable: only a SHA-256 hash and an 8-character
 * display prefix are stored.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { registerApp, rotateAppSecret } from '../platform/oauth/service.js';
import { scopeRegistry } from '../platform/scopes/registry.js';
import { HTTP_STATUS, ERROR_CODES } from '@ship/shared';

const router: Router = Router();

router.use(authMiddleware);

const CreateAppSchema = z.object({
  name: z.string().min(1).max(200),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  requested_scopes: z.array(z.string()).min(1),
});

function fail(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({ success: false, error: { code, message, details } });
}

/** Secrets must never be cached by a proxy or the browser's back-button. */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

/** GET /api/oauth-apps — the portal's app list. Never returns secrets. */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT id, name, client_id, client_secret_prefix, redirect_uris, requested_scopes,
              is_first_party, active, created_at, secret_rotated_at
         FROM oauth_apps
        WHERE workspace_id = $1
        ORDER BY created_at DESC`,
      [req.workspaceId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/oauth-apps/scopes — scopes as data, for the registration form. */
router.get('/scopes', (_req: Request, res: Response) => {
  res.json({ success: true, data: scopeRegistry.listDefinitions() });
});

/** POST /api/oauth-apps — register an app. Raw secret shown EXACTLY ONCE. */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const parsed = CreateAppSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Invalid app registration', parsed.error.issues);
    return;
  }

  const unknown = parsed.data.requested_scopes.filter((s) => !scopeRegistry.has(s));
  if (unknown.length > 0) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, `Unknown scopes: ${unknown.join(', ')}`, {
      known_scopes: scopeRegistry.list(),
    });
    return;
  }

  try {
    const { app, rawClientSecret } = await registerApp({
      workspaceId: req.workspaceId,
      ownerUserId: req.userId,
      name: parsed.data.name,
      redirectUris: parsed.data.redirect_uris,
      requestedScopes: parsed.data.requested_scopes,
    });

    noStore(res);
    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      data: {
        id: app.id,
        name: app.name,
        client_id: app.client_id,
        client_secret: rawClientSecret,
        client_secret_prefix: app.client_secret_prefix,
        redirect_uris: app.redirect_uris,
        requested_scopes: app.requested_scopes,
        created_at: app.created_at,
        warning: 'This is the only time the client secret will be shown. Store it now.',
      },
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/oauth-apps/:id/rotate-secret — new secret shown once; old one dies immediately. */
router.post('/:id/rotate-secret', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const owned = await pool.query('SELECT id FROM oauth_apps WHERE id = $1 AND workspace_id = $2', [
      req.params.id,
      req.workspaceId,
    ]);
    if (!owned.rows[0]) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'App not found');
      return;
    }

    const rotated = await rotateAppSecret(String(req.params.id));
    if (!rotated) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'App not found');
      return;
    }

    noStore(res);
    res.json({
      success: true,
      data: {
        client_secret: rotated.rawClientSecret,
        warning: 'The previous secret is now invalid. This is the only time the new secret will be shown.',
      },
    });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/oauth-apps/:id — deactivate; outstanding tokens stop working. */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      'UPDATE oauth_apps SET active = false WHERE id = $1 AND workspace_id = $2 RETURNING id',
      [req.params.id, req.workspaceId]
    );
    if (!result.rows[0]) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'App not found');
      return;
    }
    await pool.query('UPDATE api_tokens SET revoked_at = NOW() WHERE oauth_app_id = $1 AND revoked_at IS NULL', [
      req.params.id!,
    ]);
    res.json({ success: true, data: { id: req.params.id, active: false } });
  } catch (err) {
    next(err);
  }
});

export default router;
