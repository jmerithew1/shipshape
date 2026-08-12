/**
 * Token-bucket arithmetic under a VIRTUAL clock. Nothing here sleeps: `clock`
 * is a mutable number the tests advance by hand, which is the whole reason the
 * bucket takes an injected `now()`.
 */
import { describe, it, expect } from 'vitest';
import { TokenBucket } from './bucket.js';
import { InMemoryRateLimiter } from './limiter.js';

/** A hand-cranked clock. `advance(ms)` is the test's only source of time. */
function virtualClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

describe('TokenBucket', () => {
  it('rejects nonsensical policies at construction', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSec: 1 })).toThrow(/capacity/);
    expect(() => new TokenBucket({ capacity: 5, refillPerSec: 0 })).toThrow(/refillPerSec/);
  });

  it('starts full and spends down to empty, then denies', () => {
    const clock = virtualClock();
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1, now: clock.now });

    expect(bucket.consume()).toMatchObject({ allowed: true, remaining: 2, limit: 3 });
    expect(bucket.consume()).toMatchObject({ allowed: true, remaining: 1 });
    expect(bucket.consume()).toMatchObject({ allowed: true, remaining: 0 });

    const denied = bucket.consume();
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('refills at exactly refillPerSec as virtual time advances', () => {
    const clock = virtualClock();
    const bucket = new TokenBucket({ capacity: 10, refillPerSec: 2, now: clock.now });

    for (let i = 0; i < 10; i++) expect(bucket.consume().allowed).toBe(true);
    expect(bucket.consume().allowed).toBe(false);

    clock.advance(500); // 0.5s at 2/s = exactly 1 token
    expect(bucket.peek()).toBeCloseTo(1, 6);
    expect(bucket.consume().allowed).toBe(true);
    expect(bucket.consume().allowed).toBe(false);

    clock.advance(2_000); // 4 more tokens
    expect(bucket.peek()).toBeCloseTo(4, 6);
  });

  it('never refills above capacity, however long it idles', () => {
    const clock = virtualClock();
    const bucket = new TokenBucket({ capacity: 5, refillPerSec: 1, now: clock.now });

    expect(bucket.consume().allowed).toBe(true);
    clock.advance(60 * 60 * 1000); // an hour of idling
    expect(bucket.peek()).toBe(5);
    expect(bucket.isFull()).toBe(true);
  });

  it('does not partially consume on denial', () => {
    const clock = virtualClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 1, now: clock.now });

    bucket.consume();
    bucket.consume();
    clock.advance(400); // 0.4 tokens — not enough for a whole request
    const denied = bucket.consume();
    expect(denied.allowed).toBe(false);
    // The 0.4 partial token survives the rejection rather than being burned.
    expect(bucket.peek()).toBeCloseTo(0.4, 6);
  });

  it('reports Retry-After as whole seconds, never zero, when denied', () => {
    const clock = virtualClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 0.25, now: clock.now });

    expect(bucket.consume().allowed).toBe(true);
    const denied = bucket.consume();
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(4); // 1 token at 0.25/s

    clock.advance(3_900);
    const stillDenied = bucket.consume();
    expect(stillDenied.allowed).toBe(false);
    expect(stillDenied.retryAfterSeconds).toBe(1); // rounded up, floored at 1
  });

  it('reports X-RateLimit-Reset as the epoch second the bucket refills fully', () => {
    const clock = virtualClock(1_700_000_000_000); // exactly epoch second 1_700_000_000
    const bucket = new TokenBucket({ capacity: 4, refillPerSec: 2, now: clock.now });

    const first = bucket.consume(); // 1 token missing -> 0.5s to full
    expect(first.resetAt).toBe(1_700_000_001);

    bucket.consume();
    bucket.consume();
    const fourth = bucket.consume(); // empty -> 4 tokens at 2/s = 2s to full
    expect(fourth.resetAt).toBe(1_700_000_002);
  });

  it('treats a backwards clock as zero elapsed rather than minting tokens', () => {
    const clock = virtualClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 1, now: clock.now });

    bucket.consume();
    bucket.consume();
    clock.advance(-60_000); // NTP step backwards
    expect(bucket.consume().allowed).toBe(false);
    expect(bucket.peek()).toBe(0);
  });
});

describe('InMemoryRateLimiter', () => {
  const POLICY = { capacity: 2, refillPerSec: 1 };

  it('isolates keys: one key exhausting its bucket does not touch another', async () => {
    const clock = virtualClock();
    const limiter = new InMemoryRateLimiter({ now: clock.now });

    expect((await limiter.consume('app:a', POLICY)).allowed).toBe(true);
    expect((await limiter.consume('app:a', POLICY)).allowed).toBe(true);
    expect((await limiter.consume('app:a', POLICY)).allowed).toBe(false);

    // A different app is completely unaffected.
    expect((await limiter.consume('app:b', POLICY)).allowed).toBe(true);
    expect((await limiter.consume('app:b', POLICY)).remaining).toBe(0);
    // ...and so is a personal token.
    expect((await limiter.consume('token:t1', POLICY)).allowed).toBe(true);
  });

  it('keeps one bucket per key and sweeps refilled ones', async () => {
    const clock = virtualClock();
    const limiter = new InMemoryRateLimiter({ now: clock.now });

    await limiter.consume('app:a', POLICY);
    await limiter.consume('app:b', POLICY);
    expect(limiter.size()).toBe(2);

    limiter.sweep(); // nothing full yet
    expect(limiter.size()).toBe(2);

    clock.advance(10_000);
    limiter.sweep();
    expect(limiter.size()).toBe(0);

    // Evicting a full bucket is lossless: the key comes back at full capacity.
    expect((await limiter.consume('app:a', POLICY)).remaining).toBe(1);
  });

  it('evicts rather than growing past maxKeys', async () => {
    const clock = virtualClock();
    const limiter = new InMemoryRateLimiter({ now: clock.now, maxKeys: 2 });

    await limiter.consume('k1', POLICY);
    await limiter.consume('k2', POLICY);
    clock.advance(10_000); // both refill to full
    await limiter.consume('k3', POLICY);

    expect(limiter.size()).toBe(1);
  });
});
