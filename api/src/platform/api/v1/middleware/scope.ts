/**
 * requireScope(scope) — the middleware factory every public route declares
 * its authorization with (MVP gates A4/A6).
 *
 * Two properties the assignment asks for, both structural:
 *   - scopes are DATA: this file never enumerates them, it asks the registry.
 *     Adding a scope means editing the registry, never this middleware.
 *   - a 403 NAMES the missing scope. No opaque "forbidden" — the caller is a
 *     developer who needs to know which grant to request.
 *
 * assertKnown() runs at FACTORY time (module load), so a typo'd scope in a
 * route declaration crashes the process at boot rather than becoming a silent
 * always-403 in production.
 */
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ApiError } from '../errors.js';
import { scopeRegistry } from '../../../scopes/registry.js';

export function requireScope(scope: string): RequestHandler {
  scopeRegistry.assertKnown(scope);

  return function scopeCheck(req: Request, _res: Response, next: NextFunction): void {
    const ctx = req.platform;
    if (!ctx) {
      // Route mounted without tokenGate ahead of it — a wiring bug, not a
      // client error, but it must never fall through as authorized.
      next(ApiError.unauthorized('Authentication required'));
      return;
    }

    if (ctx.grantedScopes.includes(scope)) {
      next();
      return;
    }

    next(ApiError.insufficientScope(scope));
  };
}
