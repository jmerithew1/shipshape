/**
 * /api/v1 router — the public API surface.
 *
 * Boundary rules (enforced by ESLint, see eslint.config.mjs):
 *   - nothing under api/src/platform/ may import internal route handlers
 *   - integrations/ may import only @ship/sdk
 *
 * Middleware order (each its own named file, by design — the defense answer
 * is the directory listing): request-id → [authn → scope → ratelimit] (per
 * route, via the route factory) → handler → audit; this file owns only the
 * envelope: request-id first, ApiError-shaped 404 and error handler last.
 *
 * Registration happens through the route factory (routes are added by
 * register callbacks) so OpenAPI metadata and the Express handler are
 * declared in one call and the spec can never drift from the router.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { ApiError } from './errors.js';
import { requestIdMiddleware, requireRequestId } from './middleware/request-id.js';

export type V1Register = (router: Router) => void;

export function createV1Router(register?: V1Register): Router {
  const router = Router();

  router.use(requestIdMiddleware);

  // Route registration point — the route factory (openapi-v1) plugs in here.
  if (register) register(router);

  // Unknown v1 path: still the ApiError shape. This must stay ahead of the
  // app-level SPA fallback or unknown API paths would return HTML.
  router.use((req: Request, res: Response) => {
    const err = ApiError.notFound(`No such endpoint: ${req.method} ${req.path}`);
    res.status(err.status).json(err.toBody(requireRequestId(req)));
  });

  // Error handler — every thrown/next()ed error ships the envelope.
  // The 4-arg signature is load-bearing: Express only treats 4-arg
  // middleware as an error handler.
  router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const apiErr = err instanceof ApiError ? err : ApiError.server();
    if (!(err instanceof ApiError)) {
      // Unexpected failure: log the real error, ship the opaque envelope.
      console.error(`[api/v1] unhandled error (request ${req.requestId}):`, err);
    }
    res.status(apiErr.status).json(apiErr.toBody(requireRequestId(req)));
  });

  return router;
}
