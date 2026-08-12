/**
 * Token bucket — the arithmetic half of per-app rate limiting.
 *
 * PURE AND CLOCK-INJECTED ON PURPOSE. There is no timer, no interval, and no
 * sleeping anywhere in this file: refill is computed lazily from elapsed time
 * on each `consume()`. Two consequences that matter more than they look:
 *
 *   - tests advance a virtual clock and assert refill exactly, in
 *     microseconds, instead of `await sleep(1000)` and hoping;
 *   - a bucket costs one object and zero scheduler entries, so holding tens of
 *     thousands of them is fine — which is what makes the in-memory limiter
 *     viable at all.
 *
 * Token bucket rather than a fixed window because the public contract promises
 * BURSTS: an app may spend its whole capacity at once (the common "sync 100
 * documents on connect" shape) and then be metered down to the sustained
 * refill rate. A fixed window would either forbid the burst or let a client
 * fire 2x capacity across a window boundary.
 */

export interface TokenBucketOptions {
  /** Maximum tokens the bucket can hold — i.e. the largest allowed burst. */
  capacity: number;
  /** Sustained rate, in tokens per second, at which the bucket refills. */
  refillPerSec: number;
  /** Injected clock, epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Bucket capacity — the value published as `X-RateLimit-Limit`. */
  limit: number;
  /** Whole tokens left after this decision (`X-RateLimit-Remaining`). */
  remaining: number;
  /**
   * Epoch SECONDS at which the bucket is back to full (`X-RateLimit-Reset`).
   * Epoch, not a duration: that is what the legacy `X-RateLimit-*` family
   * means and what @ship/sdk's rate-limit reader already parses.
   */
  resetAt: number;
  /** Whole seconds until the request could succeed. Always >= 1 when denied. */
  retryAfterSeconds: number;
}

export class TokenBucket {
  private tokens: number;
  private updatedAtMs: number;
  private readonly now: () => number;

  constructor(private readonly options: TokenBucketOptions) {
    if (options.capacity <= 0) throw new Error('TokenBucket capacity must be > 0');
    if (options.refillPerSec <= 0) throw new Error('TokenBucket refillPerSec must be > 0');
    this.now = options.now ?? Date.now;
    this.tokens = options.capacity;
    this.updatedAtMs = this.now();
  }

  /** Tokens available right now, after applying elapsed-time refill. */
  peek(): number {
    this.refill();
    return this.tokens;
  }

  /** A full bucket has no memory worth keeping — see the store's sweep. */
  isFull(): boolean {
    return this.peek() >= this.options.capacity;
  }

  /**
   * Take `cost` tokens if they are there. Never partially consumes: a denied
   * request leaves the bucket untouched, so a rejected caller cannot starve an
   * accepted one by retrying.
   */
  consume(cost = 1): RateLimitDecision {
    this.refill();
    const { capacity, refillPerSec } = this.options;
    const allowed = this.tokens >= cost;
    if (allowed) this.tokens -= cost;

    const nowSec = this.updatedAtMs / 1000;
    const deficit = Math.max(0, capacity - this.tokens);
    const resetAt = Math.ceil(nowSec + deficit / refillPerSec);

    // Denied: how long until `cost` tokens exist. Rounded UP and floored at 1,
    // because `Retry-After: 0` invites an immediate retry that fails again.
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((cost - this.tokens) / refillPerSec));

    return {
      allowed,
      limit: capacity,
      remaining: Math.max(0, Math.floor(this.tokens)),
      resetAt,
      retryAfterSeconds,
    };
  }

  private refill(): void {
    const nowMs = this.now();
    // A clock that goes backwards (NTP step, injected test clock) must not
    // manufacture tokens or freeze the bucket: clamp elapsed at zero and
    // re-anchor.
    const elapsedMs = Math.max(0, nowMs - this.updatedAtMs);
    if (elapsedMs > 0) {
      this.tokens = Math.min(
        this.options.capacity,
        this.tokens + (elapsedMs / 1000) * this.options.refillPerSec
      );
    }
    this.updatedAtMs = nowMs;
  }
}
