/**
 * Session-authed alias for the webhook management surface, for the developer
 * portal only.
 *
 * WHY THIS EXISTS. The portal is the operator's own dashboard over their own
 * workspace, and it authenticates with a session cookie. The webhook
 * management routes live on `/api/v1`, which is a BEARER-TOKEN surface by
 * design. The result shipped broken: the Subscriptions and Deliveries tabs
 * called `/api/v1/webhooks*` with only a cookie and got
 * `401 {"code":"unauthorized","message":"Missing bearer token"}` on every
 * request. `web/src/pages/devportal/api.ts` even predicted this in its header
 * — "if the webhook routes land behind a session-authed portal alias instead,
 * repointing the whole feature is a one-line change here" — and that alias is
 * this file.
 *
 * The alternative — teaching the v1 token gate to accept session cookies —
 * was rejected: it would put a browser-cookie authentication path on the
 * public API, which is the surface third parties call. A first-party operator
 * UI wanting cookie auth is not a reason to weaken the contract everyone else
 * depends on. Same reasoning as `/api/devportal/audit-log` (platform/audit/
 * routes.ts): the portal reading your own workspace's data is internal, not a
 * third-party integration acting on a user's behalf.
 *
 * WHAT THIS IS NOT: a second implementation. Every route delegates to the same
 * service functions the v1 handlers call, with the same tenant keys, and
 * returns byte-identical response shapes — which is precisely what let the
 * portal switch over by changing one constant.
 *
 * TENANCY. `workspace_id` comes from the SESSION, never the request body, and
 * `app_id` is checked to belong to that workspace before any webhook query
 * runs. Without that check a signed-in user could pass any app's id and read
 * or delete another workspace's subscriptions — the same cross-tenant defect
 * that was fixed on the v1 side, which would have been reintroduced here.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from '../../db/client.js';
import {
  createSubscription,
  deleteSubscription,
  listDeliveries,
  listSubscriptions,
  replayDelivery,
  WebhookServiceError,
} from './service.js';

export interface PortalWebhookRouterDeps {
  /** Session auth. Must populate `req.workspaceId` (and ideally `req.userId`). */
  auth: RequestHandler;
}

/** ApiError-shaped body, so the portal's existing v1 error reader works unchanged. */
function fail(res: Response, status: number, code: string, message: string, details?: unknown) {
  res.status(status).json({ code, message, request_id: randomUUID(), ...(details ? { details } : {}) });
}

function serviceErrorStatus(err: WebhookServiceError): [number, string] {
  switch (err.code) {
    case 'not_found':
      return [404, 'not_found'];
    case 'unknown_event_type':
    case 'invalid_target_url':
    case 'duplicate_subscription':
      return [400, 'validation_failed'];
    default:
      return [500, 'server_error'];
  }
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof WebhookServiceError) {
    const [status, code] = serviceErrorStatus(err);
    fail(res, status, code, err.message, err.details);
    return;
  }
  console.error('[devportal/webhooks] unexpected error', err);
  fail(res, 500, 'server_error', 'Internal server error');
}

/**
 * Resolve the app the request is about, proving it belongs to the session's
 * workspace. Returns null and answers the request when it cannot.
 */
async function resolveApp(req: Request, res: Response): Promise<{ appId: string; workspaceId: string } | null> {
  const workspaceId = req.workspaceId;
  if (!workspaceId) {
    fail(res, 400, 'validation_failed', 'No workspace selected');
    return null;
  }

  const raw = (req.query.app_id ?? (req.body as { app_id?: unknown } | undefined)?.app_id) as unknown;
  const appId = typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  if (!appId) {
    fail(res, 400, 'validation_failed', 'app_id is required');
    return null;
  }

  const owned = await pool.query<{ id: string }>(
    'SELECT id FROM oauth_apps WHERE id = $1 AND workspace_id = $2',
    [appId, workspaceId]
  );
  // Same 404 whether the app does not exist or belongs to someone else — a
  // distinct 403 would confirm the id is real to a caller who should not know.
  if (owned.rows.length === 0) {
    fail(res, 404, 'not_found', 'App not found');
    return null;
  }

  return { appId, workspaceId };
}

export function createPortalWebhookRouter(deps: PortalWebhookRouterDeps): Router {
  const router: Router = Router();
  router.use(deps.auth);

  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next: NextFunction) => {
      fn(req, res).catch((err) => {
        try {
          handleError(res, err);
        } catch {
          next(err);
        }
      });
    };

  // NOTE: `/webhooks/deliveries` is declared before `/webhooks/:id` so the
  // literal segment is never captured as an id.
  router.get(
    '/webhooks/deliveries',
    wrap(async (req, res) => {
      const app = await resolveApp(req, res);
      if (!app) return;
      const q = req.query as Record<string, string | undefined>;
      const page = await listDeliveries({
        appId: app.appId,
        workspaceId: app.workspaceId,
        subscriptionId: q.subscription_id,
        status: q.status,
        cursor: q.cursor,
        limit: q.limit ? Number(q.limit) : undefined,
      });
      res.json(page);
    })
  );

  router.post(
    '/webhooks/deliveries/:id/replay',
    wrap(async (req, res) => {
      const app = await resolveApp(req, res);
      if (!app) return;
      const replay = await replayDelivery({
        id: String(req.params.id),
        appId: app.appId,
        workspaceId: app.workspaceId,
      });
      res.status(202).json(replay);
    })
  );

  router.get(
    '/webhooks',
    wrap(async (req, res) => {
      const app = await resolveApp(req, res);
      if (!app) return;
      const eventType = typeof req.query.event_type === 'string' ? req.query.event_type : undefined;
      const subscriptions = await listSubscriptions({
        appId: app.appId,
        workspaceId: app.workspaceId,
        eventType: eventType as never,
      });
      // Same envelope as v1, `next_cursor` permanently null — see the v1
      // handler for why the shape is uniform even when there is never a page 2.
      res.json({ data: subscriptions, next_cursor: null });
    })
  );

  router.post(
    '/webhooks',
    wrap(async (req, res) => {
      const app = await resolveApp(req, res);
      if (!app) return;
      const body = (req.body ?? {}) as { event_type?: string; target_url?: string };
      if (!body.event_type || !body.target_url) {
        fail(res, 400, 'validation_failed', 'event_type and target_url are required');
        return;
      }
      const { subscription, rawSigningSecret } = await createSubscription({
        appId: app.appId,
        workspaceId: app.workspaceId,
        eventType: body.event_type,
        targetUrl: body.target_url,
        createdBy: req.userId ?? null,
      });
      // The raw secret exists in this response and nowhere else; keep it out of
      // intermediary and back/forward caches.
      res.set('Cache-Control', 'no-store');
      res.status(201).json({ ...subscription, signing_secret: rawSigningSecret });
    })
  );

  router.delete(
    '/webhooks/:id',
    wrap(async (req, res) => {
      const app = await resolveApp(req, res);
      if (!app) return;
      const deleted = await deleteSubscription({
        appId: app.appId,
        workspaceId: app.workspaceId,
        id: String(req.params.id),
      });
      if (!deleted) {
        fail(res, 404, 'not_found', 'Webhook subscription not found');
        return;
      }
      res.status(204).end();
    })
  );

  return router;
}
