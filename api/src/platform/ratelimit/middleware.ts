/**
 * rateLimit() — the public API's throttle (Week 6 brief, "Rate Limiting").
 *
 * KEYING. The bucket key is the OAuth app when the caller is one, and the
 * token otherwise:
 *
 *     app:<oauth_app_id>   third-party integration — all of its tokens,
 *                          across all of its users, share one allowance
 *     token:<token_id>     personal access token — its own allowance
 *
 * Keying third parties by APP rather than by token is the load-bearing choice.
 * A misbehaving integration cannot buy itself more throughput by minting more
 * tokens, which is precisely the loophole a per-token-only limiter leaves open,
 * and the noisy-neighbour blast radius stays inside the app that caused it.
 * Apps and personal tokens get separate policies because they are separate
 * traffic shapes: an integration polling on a schedule needs a bigger burst
 * than a human's script.
 *
 * MOUNT POSITION. This middleware reads `req.platform`, so it must run AFTER
 * tokenGate — i.e. inside the per-route chain the v1 route factory builds
 * (tokenGate -> requireScope -> rateLimit -> validate -> handler), not as
 * router-level `use()` above the routes. Unauthenticated requests are not
 * metered here on purpose: they never reach a handler, and tokenGate has
 * already rejected them.
 *
 * FAILURE POSTURE. Fail OPEN. A limiter that cannot answer must not take the
 * API down with it — availability outranks precision of metering. In-memory
 * cannot fail; the branch exists so a future networked backend inherits the
 * right behaviour rather than needing this decision made again under pressure.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ApiError } from '../api/v1/errors.js';
import { InMemoryRateLimiter, type RateLimiter, type RateLimitPolicy } from './limiter.js';

export interface RateLimitOptions {
  /** Storage backend. Defaults to the process-wide in-memory limiter. */
  limiter?: RateLimiter;
  /** Policy for OAuth-app-keyed callers. Defaults to env / built-in. */
  appPolicy?: RateLimitPolicy;
  /** Policy for personal-token-keyed callers. Defaults to env / built-in. */
  tokenPolicy?: RateLimitPolicy;
  /** Force the kill switch. Defaults to env (see `rateLimitEnabled`). */
  enabled?: boolean;
  /** Env source, injected for tests. */
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_APP_POLICY: RateLimitPolicy = { capacity: 120, refillPerSec: 2 };
export const DEFAULT_TOKEN_POLICY: RateLimitPolicy = { capacity: 60, refillPerSec: 1 };

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Limits are env-configurable so an operator can retune them without a deploy
 * of new code. Unparseable values fall back to the default rather than
 * throwing: a typo'd env var must not be able to take the API offline at boot.
 */
export function policiesFromEnv(env: NodeJS.ProcessEnv = process.env): {
  app: RateLimitPolicy;
  token: RateLimitPolicy;
} {
  return {
    app: {
      capacity: positiveNumber(env.RATE_LIMIT_APP_CAPACITY, DEFAULT_APP_POLICY.capacity),
      refillPerSec: positiveNumber(
        env.RATE_LIMIT_APP_REFILL_PER_SEC,
        DEFAULT_APP_POLICY.refillPerSec
      ),
    },
    token: {
      capacity: positiveNumber(env.RATE_LIMIT_TOKEN_CAPACITY, DEFAULT_TOKEN_POLICY.capacity),
      refillPerSec: positiveNumber(
        env.RATE_LIMIT_TOKEN_REFILL_PER_SEC,
        DEFAULT_TOKEN_POLICY.refillPerSec
      ),
    },
  };
}

/**
 * Kill switch. Explicit `RATE_LIMIT_ENABLED` always wins; otherwise the
 * limiter is ON everywhere except tests, where a shared bucket across a suite
 * that fires hundreds of requests would produce 429s that have nothing to do
 * with the behaviour under test. Rate-limit suites opt in explicitly.
 */
export function rateLimitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RATE_LIMIT_ENABLED !== undefined) return env.RATE_LIMIT_ENABLED !== 'false';
  return env.NODE_ENV !== 'test';
}

/**
 * Process-wide default store. Shared deliberately: the route factory calls
 * rateLimit() once per route, and a per-call limiter would give every endpoint
 * its own private allowance — an app could then spend `capacity` on each of N
 * routes and pay nothing for the aggregate.
 */
export const sharedRateLimiter = new InMemoryRateLimiter();

/** Key an authenticated request. App id wins; token id is the fallback. */
export function rateLimitKey(req: Request): string | null {
  const ctx = req.platform;
  if (!ctx) return null;
  if (ctx.oauthAppId) return `app:${ctx.oauthAppId}`;
  if (ctx.tokenId) return `token:${ctx.tokenId}`;
  return null;
}

export function rateLimit(options: RateLimitOptions = {}): RequestHandler {
  const env = options.env ?? process.env;
  const fromEnv = policiesFromEnv(env);
  const limiter = options.limiter ?? sharedRateLimiter;
  const appPolicy = options.appPolicy ?? fromEnv.app;
  const tokenPolicy = options.tokenPolicy ?? fromEnv.token;
  const enabled = options.enabled ?? rateLimitEnabled(env);

  return function rateLimitGate(req: Request, res: Response, next: NextFunction): void {
    if (!enabled) {
      next();
      return;
    }

    const key = rateLimitKey(req);
    if (!key) {
      next();
      return;
    }

    const policy = req.platform?.oauthAppId ? appPolicy : tokenPolicy;

    void limiter
      .consume(key, policy)
      .then((decision) => {
        // The brief names these three headers verbatim; they are set on the
        // allow AND the deny path so a throttled client can see its own budget
        // recovering without a second request.
        res.setHeader('X-RateLimit-Limit', String(decision.limit));
        res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
        res.setHeader('X-RateLimit-Reset', String(decision.resetAt));

        if (decision.allowed) {
          next();
          return;
        }

        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        next(ApiError.rateLimited(decision.retryAfterSeconds));
      })
      .catch((err: unknown) => {
        console.error(`[api/v1] rate limiter unavailable (request ${req.requestId}):`, err);
        next(); // fail open — see the file header
      });
  };
}
