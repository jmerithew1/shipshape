/**
 * GET /api/devportal/audit-log — the developer portal's read of the public
 * audit trail.
 *
 * SESSION-AUTHED, like /api/oauth-apps and for the same reason: this is the
 * operator's own dashboard looking at their own workspace's traffic, not a
 * third-party integration reading data on a user's behalf. Putting it on
 * /api/v1 would mean the portal needs an OAuth token to show you the log of
 * your OAuth tokens.
 *
 * The auth middleware is INJECTED rather than imported so this file stays free
 * of the internal session stack (and so its tests need no session). It is also
 * what keeps the public/internal boundary lint rule satisfiable: platform code
 * never reaches into api/src/routes/.
 */
import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { queryAuditLog } from './service.js';

export interface AuditRouterDeps {
  /** Session auth. Must populate `req.workspaceId`. */
  auth: RequestHandler;
}

export function createAuditRouter(deps: AuditRouterDeps): Router {
  const router: Router = Router();
  router.use(deps.auth);

  router.get('/audit-log', (req: Request, res: Response, next: NextFunction) => {
    const workspaceId = req.workspaceId;
    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'No workspace selected' },
      });
      return;
    }

    const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : null;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;

    queryAuditLog({ workspaceId, clientId, cursor, limit })
      .then((page) => {
        res.json({ success: true, data: { logs: page.data, next_cursor: page.next_cursor } });
      })
      .catch(next);
  });

  return router;
}
