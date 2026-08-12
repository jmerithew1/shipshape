/**
 * Request-ID middleware — first middleware on the v1 router.
 *
 * request_id is the platform's single correlation ID: it appears in every
 * ApiError body, every public_audit_log row, and (for webhook-triggering
 * writes) the delivery log — one grep answers "what happened, in what order".
 */
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = crypto.randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/** Fallback for contexts where the middleware demonstrably ran but types don't know. */
export function requireRequestId(req: Request): string {
  return req.requestId ?? 'missing-request-id';
}
