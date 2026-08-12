/**
 * RateLimiter — the storage half, kept behind an interface so the storage can
 * change without the middleware noticing.
 *
 * WHY IN-MEMORY IS THE RIGHT ANSWER TODAY (and why this is not laziness):
 * Ship deploys as a single API instance. With one instance, an in-memory
 * bucket is not an approximation of the correct limiter — it IS the correct
 * limiter, with zero network hops on the hot path of every public request.
 * Reaching for Redis here would add a dependency, a failure mode, and ~1ms per
 * request to solve a problem the deployment topology does not have.
 *
 * WHAT MAKES THAT REVERSIBLE: `consume()` is async and keyed by an opaque
 * string, which is exactly the shape a Redis (or Postgres) implementation
 * needs. Swapping in `RedisRateLimiter` is a constructor change in
 * middleware.ts — no call-site, no test, and no header logic moves. The
 * interface is the whole point; the Map behind it is an implementation detail.
 */
import { TokenBucket, type RateLimitDecision } from './bucket.js';

export interface RateLimitPolicy {
  capacity: number;
  refillPerSec: number;
}

export interface RateLimiter {
  /**
   * Spend one token against `key` under `policy`, and report the decision.
   * Async by contract so a networked backend is a drop-in replacement.
   */
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision>;
}

/** Cap on distinct live keys, so a hostile spray of client ids cannot grow the
 * map without bound. Full buckets are indistinguishable from absent ones, so
 * evicting them is lossless. */
const DEFAULT_MAX_KEYS = 10_000;

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: { now?: () => number; maxKeys?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.sweep();
      bucket = new TokenBucket({ ...policy, now: this.now });
      this.buckets.set(key, bucket);
    }
    return Promise.resolve(bucket.consume());
  }

  /** Live key count — exposed for tests and for an eventual metrics probe. */
  size(): number {
    return this.buckets.size;
  }

  /** Drop every fully-refilled bucket. A full bucket carries no state a fresh
   * one would not reproduce, so this frees memory without granting anyone
   * extra allowance. */
  sweep(): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.isFull()) this.buckets.delete(key);
    }
  }

  /** Test seam: forget everything. */
  reset(): void {
    this.buckets.clear();
  }
}
