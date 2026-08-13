/**
 * Idempotency-key dedupe for inbound deliveries.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ship's delivery contract is at-least-once. A delivery that times out is
 * retried, and a manual replay from the portal reuses the ORIGINAL idempotency
 * key (it is derived from the event id, not the attempt — see
 * `idempotencyKeyFor` in Ship's event registry). So a subscriber that posts on
 * every inbound request posts the same message to Slack two, three, six times.
 * The naive receiver is not "mostly fine": it is wrong on exactly the paths
 * that matter, because retries happen when things are already going badly.
 *
 * CLAIM / RELEASE, NOT JUST "SEEN"
 * --------------------------------
 * A plain `seen` set has a subtle failure: mark on arrival and a delivery whose
 * Slack post failed transiently is never retried successfully — Ship retries,
 * we say "duplicate", and the message is lost forever. Mark on success instead
 * and two concurrent attempts both post.
 *
 * So the key is CLAIMED before posting and RELEASED if (and only if) the post
 * failed transiently and Ship should try again. A permanent failure keeps the
 * claim: retrying it would fail identically.
 *
 * PRODUCTION NOTE
 * ---------------
 * This is an in-memory bounded LRU. It survives neither a restart nor a second
 * replica, which means a redeploy mid-retry can produce one duplicate Slack
 * message. A production subscriber persists this — Redis `SET key NX EX 86400`,
 * or a unique index on the idempotency key in Postgres — and keeps entries for
 * at least as long as Ship's retry ladder runs (~hours). The bound matters
 * either way: an unbounded Set on a busy workspace is a slow memory leak.
 */

export const DEFAULT_MAX_ENTRIES = 5000;

export interface IdempotencyStoreOptions {
  /** Bound on retained keys. Oldest are evicted first (insertion-order LRU). */
  maxEntries?: number;
  /**
   * When false, `claim` always succeeds. This is not a convenience switch — it
   * is the control arm for the dedupe test: with dedupe off the same replayed
   * delivery must produce TWO Slack posts, which is what proves the passing
   * dedupe test is measuring dedupe and not, say, a test harness that only ever
   * sends one request.
   */
  enabled?: boolean;
}

export class IdempotencyStore {
  readonly enabled: boolean;
  private readonly maxEntries: number;
  // Map preserves insertion order, which is all an LRU needs here: entries are
  // written once and never re-read for their value, so "least recently used" is
  // "oldest inserted".
  private readonly keys = new Map<string, true>();

  constructor(options: IdempotencyStoreOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  /** True when this caller now owns the key (i.e. it is the first sighting). */
  claim(key: string): boolean {
    if (!this.enabled) return true;
    if (this.keys.has(key)) return false;
    this.keys.set(key, true);
    if (this.keys.size > this.maxEntries) {
      const oldest = this.keys.keys().next();
      if (!oldest.done) this.keys.delete(oldest.value);
    }
    return true;
  }

  /** Give the key back so a Ship retry can be processed rather than swallowed. */
  release(key: string): void {
    this.keys.delete(key);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  get size(): number {
    return this.keys.size;
  }
}
