/**
 * rateLimit() mounted on a real v1 router, so the 429 path is asserted through
 * the SAME error handler production uses — the envelope shape here is not a
 * re-implementation of the contract, it is the contract.
 *
 * The clock is virtual and the limiter is injected; nothing sleeps.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createV1Router } from '../api/v1/router.js';
import { InMemoryRateLimiter } from './limiter.js';
import {
  rateLimit,
  rateLimitEnabled,
  rateLimitKey,
  policiesFromEnv,
  DEFAULT_APP_POLICY,
  DEFAULT_TOKEN_POLICY,
} from './middleware.js';

function virtualClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** Stand-in for tokenGate: sets exactly the fields rateLimit() reads. */
function fakePlatform(ctx: { tokenId: string; oauthAppId: string | null }) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.platform = {
      tokenId: ctx.tokenId,
      userId: 'user-1',
      workspaceId: 'ws-1',
      isSuperAdmin: false,
      clientId: ctx.oauthAppId ? 'client-abc' : null,
      oauthAppId: ctx.oauthAppId,
      grantedScopes: ['documents:read'],
    };
    next();
  };
}

/**
 * A v1 router with one route per identity, all sharing ONE limiter — the same
 * arrangement the route factory produces in production.
 */
function buildApp(opts: {
  limiter: InMemoryRateLimiter;
  appPolicy?: { capacity: number; refillPerSec: number };
  tokenPolicy?: { capacity: number; refillPerSec: number };
  identities: Record<string, { tokenId: string; oauthAppId: string | null }>;
}) {
  const gate = rateLimit({
    limiter: opts.limiter,
    enabled: true,
    appPolicy: opts.appPolicy ?? { capacity: 2, refillPerSec: 1 },
    tokenPolicy: opts.tokenPolicy ?? { capacity: 2, refillPerSec: 1 },
  });

  const app = express();
  app.use(
    '/api/v1',
    createV1Router((router) => {
      for (const [name, ctx] of Object.entries(opts.identities)) {
        router.get(`/${name}`, fakePlatform(ctx), gate, (_req, res) => {
          res.json({ ok: true });
        });
      }
    })
  );
  return app;
}

describe('rateLimit middleware', () => {
  let clock: ReturnType<typeof virtualClock>;
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    clock = virtualClock();
    limiter = new InMemoryRateLimiter({ now: clock.now });
  });

  it('publishes X-RateLimit-* headers on every successful request', async () => {
    const app = buildApp({
      limiter,
      identities: { ping: { tokenId: 'tok-1', oauthAppId: 'app-1' } },
      appPolicy: { capacity: 5, refillPerSec: 1 },
    });

    const res = await request(app).get('/api/v1/ping');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
    // Epoch seconds — the family @ship/sdk's rate-limit reader parses.
    expect(Number(res.headers['x-ratelimit-reset'])).toBe(1_700_000_001);

    const second = await request(app).get('/api/v1/ping');
    expect(second.headers['x-ratelimit-remaining']).toBe('3');
  });

  it('returns the ApiError envelope with Retry-After once the burst is spent', async () => {
    const app = buildApp({
      limiter,
      identities: { ping: { tokenId: 'tok-1', oauthAppId: 'app-1' } },
      appPolicy: { capacity: 2, refillPerSec: 0.5 },
    });

    expect((await request(app).get('/api/v1/ping')).status).toBe(200);
    expect((await request(app).get('/api/v1/ping')).status).toBe(200);

    const denied = await request(app).get('/api/v1/ping');
    expect(denied.status).toBe(429);
    expect(denied.headers['retry-after']).toBe('2'); // 1 token at 0.5/s
    expect(denied.headers['x-ratelimit-remaining']).toBe('0');
    expect(denied.body).toMatchObject({
      code: 'rate_limited',
      message: 'Rate limit exceeded',
      details: { retry_after_seconds: 2 },
    });
    expect(denied.body.request_id).toBe(denied.headers['x-request-id']);
  });

  it('lets the bucket recover as time passes', async () => {
    const app = buildApp({
      limiter,
      identities: { ping: { tokenId: 'tok-1', oauthAppId: 'app-1' } },
      appPolicy: { capacity: 1, refillPerSec: 1 },
    });

    expect((await request(app).get('/api/v1/ping')).status).toBe(200);
    expect((await request(app).get('/api/v1/ping')).status).toBe(429);

    clock.advance(1_000);
    expect((await request(app).get('/api/v1/ping')).status).toBe(200);
  });

  it('isolates apps: one app burning its burst does not throttle another', async () => {
    const app = buildApp({
      limiter,
      appPolicy: { capacity: 2, refillPerSec: 1 },
      identities: {
        noisy: { tokenId: 'tok-noisy', oauthAppId: 'app-noisy' },
        quiet: { tokenId: 'tok-quiet', oauthAppId: 'app-quiet' },
      },
    });

    await request(app).get('/api/v1/noisy');
    await request(app).get('/api/v1/noisy');
    expect((await request(app).get('/api/v1/noisy')).status).toBe(429);

    const other = await request(app).get('/api/v1/quiet');
    expect(other.status).toBe(200);
    expect(other.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('shares one allowance across all of an app’s tokens, but not across apps', async () => {
    const app = buildApp({
      limiter,
      appPolicy: { capacity: 2, refillPerSec: 1 },
      identities: {
        // Same app, two different tokens (two different end users).
        userA: { tokenId: 'tok-a', oauthAppId: 'app-shared' },
        userB: { tokenId: 'tok-b', oauthAppId: 'app-shared' },
      },
    });

    expect((await request(app).get('/api/v1/userA')).status).toBe(200);
    expect((await request(app).get('/api/v1/userB')).status).toBe(200);
    // The app's budget is spent — minting another token buys nothing.
    expect((await request(app).get('/api/v1/userB')).status).toBe(429);
  });

  it('isolates personal tokens from each other and from apps', async () => {
    const app = buildApp({
      limiter,
      tokenPolicy: { capacity: 1, refillPerSec: 1 },
      appPolicy: { capacity: 1, refillPerSec: 1 },
      identities: {
        pat1: { tokenId: 'tok-1', oauthAppId: null },
        pat2: { tokenId: 'tok-2', oauthAppId: null },
        viaApp: { tokenId: 'tok-1', oauthAppId: 'app-1' },
      },
    });

    expect((await request(app).get('/api/v1/pat1')).status).toBe(200);
    expect((await request(app).get('/api/v1/pat1')).status).toBe(429);
    expect((await request(app).get('/api/v1/pat2')).status).toBe(200);
    // Same token id, but app-keyed: a separate bucket.
    expect((await request(app).get('/api/v1/viaApp')).status).toBe(200);
  });

  it('applies the app policy to apps and the token policy to personal tokens', async () => {
    const app = buildApp({
      limiter,
      appPolicy: { capacity: 9, refillPerSec: 1 },
      tokenPolicy: { capacity: 3, refillPerSec: 1 },
      identities: {
        viaApp: { tokenId: 'tok-1', oauthAppId: 'app-1' },
        viaPat: { tokenId: 'tok-2', oauthAppId: null },
      },
    });

    expect((await request(app).get('/api/v1/viaApp')).headers['x-ratelimit-limit']).toBe('9');
    expect((await request(app).get('/api/v1/viaPat')).headers['x-ratelimit-limit']).toBe('3');
  });

  it('is a no-op when disabled, and when there is no auth context', async () => {
    const disabled = rateLimit({ limiter, enabled: false });
    const app = express();
    app.use(
      '/api/v1',
      createV1Router((router) => {
        router.get('/off', fakePlatform({ tokenId: 't', oauthAppId: 'a' }), disabled, (_r, res) => {
          res.json({ ok: true });
        });
        // No fakePlatform: nothing to key on.
        router.get(
          '/anon',
          rateLimit({ limiter, enabled: true, appPolicy: { capacity: 1, refillPerSec: 1 } }),
          (_r, res) => {
            res.json({ ok: true });
          }
        );
      })
    );

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/v1/off');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/v1/anon')).status).toBe(200);
    }
    expect(limiter.size()).toBe(0);
  });

  it('fails OPEN when the limiter backend throws', async () => {
    const broken = {
      consume: () => Promise.reject(new Error('redis down')),
    };
    const app = express();
    app.use(
      '/api/v1',
      createV1Router((router) => {
        router.get(
          '/ping',
          fakePlatform({ tokenId: 'tok-1', oauthAppId: 'app-1' }),
          rateLimit({ limiter: broken, enabled: true }),
          (_r, res) => {
            res.json({ ok: true });
          }
        );
      })
    );

    const res = await request(app).get('/api/v1/ping');
    expect(res.status).toBe(200);
  });
});

describe('rate-limit configuration', () => {
  it('keys apps by app id and personal tokens by token id', () => {
    const withApp = { platform: { tokenId: 't1', oauthAppId: 'a1' } } as unknown as Request;
    const withoutApp = { platform: { tokenId: 't1', oauthAppId: null } } as unknown as Request;
    expect(rateLimitKey(withApp)).toBe('app:a1');
    expect(rateLimitKey(withoutApp)).toBe('token:t1');
    expect(rateLimitKey({} as Request)).toBeNull();
  });

  it('reads limits from env, with sane defaults', () => {
    expect(policiesFromEnv({})).toEqual({ app: DEFAULT_APP_POLICY, token: DEFAULT_TOKEN_POLICY });

    expect(
      policiesFromEnv({
        RATE_LIMIT_APP_CAPACITY: '500',
        RATE_LIMIT_APP_REFILL_PER_SEC: '8.5',
        RATE_LIMIT_TOKEN_CAPACITY: '30',
        RATE_LIMIT_TOKEN_REFILL_PER_SEC: '0.5',
      })
    ).toEqual({
      app: { capacity: 500, refillPerSec: 8.5 },
      token: { capacity: 30, refillPerSec: 0.5 },
    });
  });

  it('falls back to defaults for unparseable or non-positive values', () => {
    const policies = policiesFromEnv({
      RATE_LIMIT_APP_CAPACITY: 'not-a-number',
      RATE_LIMIT_APP_REFILL_PER_SEC: '-3',
      RATE_LIMIT_TOKEN_CAPACITY: '0',
      RATE_LIMIT_TOKEN_REFILL_PER_SEC: '',
    });
    expect(policies).toEqual({ app: DEFAULT_APP_POLICY, token: DEFAULT_TOKEN_POLICY });
  });

  it('is off by default under NODE_ENV=test, on elsewhere, and env always wins', () => {
    expect(rateLimitEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(rateLimitEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(rateLimitEnabled({})).toBe(true);
    expect(rateLimitEnabled({ NODE_ENV: 'test', RATE_LIMIT_ENABLED: 'true' })).toBe(true);
    expect(rateLimitEnabled({ NODE_ENV: 'production', RATE_LIMIT_ENABLED: 'false' })).toBe(false);
  });
});
