/**
 * IWebhookDeliverer — the attempt loop, the retry ladder, and the poller.
 *
 * THE CLOCK AND THE TRANSPORT ARE INJECTED. Not for purity; because the
 * alternative is a suite that sleeps. A deliverer that calls `Date.now()` and
 * global `fetch` can only be tested by waiting 21 seconds to observe three
 * retries, and a test that waits 21 seconds is a test that gets `.skip`ped the
 * first week it goes red on a loaded CI box. With `{ now, fetch }` on the
 * constructor, the retry-ladder test asserts the exact schedule in single-digit
 * milliseconds and cannot flake: virtual time only moves when the test moves
 * it. "Timing-based webhook tests are flaky tests" — so there is no timing in
 * these tests, only arithmetic.
 *
 * THE LADDER, AND WHY THESE NUMBERS
 * ---------------------------------
 *   1s · 4s · 16s · 1m · 5m · 30m   (+ jitter)
 *
 * The head is tight because most failures are a subscriber restart or a
 * momentary 502, and those heal in seconds — waiting a minute to retry a blip
 * turns a self-healing incident into a visible outage. The tail is long
 * because a subscriber still down after a minute is down for human reasons
 * (a bad deploy, an expired certificate) and hammering it every second adds a
 * self-inflicted DDoS to somebody's already bad morning.
 *
 * JITTER IS ADDITIVE ONLY. Every delay is `base + [0, 20%)`, never less than
 * base. Multiplicative-around-center jitter would make "at least 1 second"
 * false ~half the time, and the guarantee subscribers are given — and the one
 * the tests assert — is a FLOOR. What jitter buys is the thundering herd: when
 * a subscriber comes back after an outage with 500 queued deliveries, an
 * unjittered ladder fires all 500 at the same instant and knocks it over
 * again.
 *
 * PERMANENT vs TRANSIENT (this is the part that gets it wrong in the wild)
 * -----------------------------------------------------------------------
 *   5xx / network error / timeout → transient. The subscriber is broken; it
 *     will probably be fixed.
 *   4xx → PERMANENT. Dead-letter immediately, no retries. A 404 or a 401 means
 *     the request itself is wrong; retrying an unfixable request six times is
 *     six times the load for zero chance of success.
 *   408 and 429 → transient despite being 4xx. They are the two 4xx codes that
 *     mean "not now", not "not ever". 429 honors `Retry-After`, because a
 *     subscriber that told us exactly when to come back and got ignored has
 *     every right to be annoyed.
 *   410 Gone → permanent AND deactivates the subscription. 410 is the one
 *     status that carries a durable statement about the ENDPOINT rather than
 *     the request: this URL is not coming back. Continuing to queue for it
 *     would generate dead letters forever.
 *
 * ON THE SIGNING KEY: subscription secrets are stored hashed (they are shown
 * to the operator exactly once), so the value available at delivery time is
 * `signing_secret_hash` — the deliverer signs with that derived key and the
 * subscriber verifies with `deriveSigningKey(rawSecret)`. See service.ts for
 * the full statement of that tradeoff; it is deliberate, not an oversight.
 */
import { pool } from '../../db/client.js';
import type { Queryable } from './bus.js';
import { IDEMPOTENCY_HEADER, SIGNATURE_HEADER, signPayload } from './signature.js';

// ─────────────────────────────────────────────────────────────────────────────
// The schedule, as data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The base retry ladder in milliseconds. Exported as data so the test asserts
 * the published schedule itself rather than re-deriving it — if somebody
 * "tunes" 16s to 60s, the assertion fails and the change becomes a decision
 * instead of a diff.
 */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  1_000, // 1s
  4_000, // 4s
  16_000, // 16s
  60_000, // 1m
  300_000, // 5m
  1_800_000, // 30m
] as const;

/**
 * Hard attempt cap per delivery. Six failures is the point at which more
 * retries stop being optimism and start being noise; the delivery moves to
 * `dead_lettered` and a human replays it from the portal.
 *
 * With the cap at 6, the ladder's 30m tail is the step scheduled AFTER the
 * sixth attempt — which never runs, because the sixth failure dead-letters.
 * The entry stays in the published schedule because the cap is a constructor
 * option: raising `maxAttempts` to 7 consumes the tail and yields the ~36.5
 * minute worst case the design notes quote.
 */
export const MAX_ATTEMPTS = 6;

/** Additive jitter ceiling, as a fraction of the base delay. */
export const JITTER_RATIO = 0.2;

/** Truncation limit for the stored slice of a subscriber's response body. */
export const RESPONSE_EXCERPT_LIMIT = 500;

/** Default per-attempt HTTP timeout. Beyond this the attempt is transient. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Delay after `attemptNumber` (1-based) has failed. Past the end of the ladder
 * the last step repeats — a schedule that runs off the end and returns
 * undefined is how "retry immediately, forever" bugs happen.
 */
export function retryDelayMs(attemptNumber: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(attemptNumber, 1), RETRY_SCHEDULE_MS.length) - 1;
  const base = RETRY_SCHEDULE_MS[index] ?? RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1]!;
  return base + Math.floor(random() * base * JITTER_RATIO);
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────────

export type Disposition = 'success' | 'transient' | 'permanent';

export interface Classification {
  disposition: Disposition;
  /** 410 only: the endpoint declared itself gone. */
  deactivateSubscription: boolean;
}

export function classifyStatus(status: number): Classification {
  if (status >= 200 && status < 300) return { disposition: 'success', deactivateSubscription: false };
  if (status === 410) return { disposition: 'permanent', deactivateSubscription: true };
  if (status === 408 || status === 429) return { disposition: 'transient', deactivateSubscription: false };
  if (status >= 400 && status < 500) return { disposition: 'permanent', deactivateSubscription: false };
  if (status >= 500) return { disposition: 'transient', deactivateSubscription: false };
  // 1xx/3xx: a webhook endpoint that answers with a redirect or a continue is
  // misconfigured, and following redirects blindly is an SSRF gadget. Not an
  // acknowledgement, not worth retrying.
  return { disposition: 'permanent', deactivateSubscription: false };
}

/** `Retry-After` as seconds. Accepts the delta-seconds and HTTP-date forms. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.ceil((when - nowMs) / 1000));
}

/** Ceiling on an honored `Retry-After`. A subscriber does not get to park a
 *  delivery for a week; past this we fall back to the ladder. */
export const MAX_RETRY_AFTER_SECONDS = 3_600;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'failed' | 'dead_lettered';

export interface DeliveryAttempt {
  deliveryId: string;
  attemptNumber: number;
  status: DeliveryStatus;
  responseStatus: number | null;
  responseExcerpt: string | null;
  latencyMs: number;
  /** Epoch ms of the next scheduled attempt, or null if terminal. */
  nextAttemptAtMs: number | null;
  /** Scheduled wait after this attempt, in ms. Null when terminal. */
  scheduledDelayMs: number | null;
  error: string | null;
  subscriptionDeactivated: boolean;
}

export interface IWebhookDeliverer {
  /** Run exactly one attempt for one delivery row. */
  deliverOnce(deliveryId: string): Promise<DeliveryAttempt | null>;
}

export interface DelivererDeps {
  /** Injected clock. Epoch milliseconds. */
  now: () => number;
  /** Injected transport. Same contract as global fetch. */
  fetch: typeof fetch;
  /** Only the poller sleeps; the deliverer never does. Injectable regardless. */
  sleep?: (ms: number) => Promise<void>;
  db?: Queryable;
  /** Injected jitter source, so the ladder is exactly reproducible in tests. */
  random?: () => number;
  timeoutMs?: number;
  maxAttempts?: number;
}

interface DeliveryJoinRow {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  idempotency_key: string;
  status: DeliveryStatus;
  attempt_number: number;
  target_url: string;
  signing_secret_hash: string;
  subscription_active: boolean;
}

const DELIVERY_JOIN_SQL = `
  SELECT d.id, d.subscription_id, d.event_id, d.event_type, d.payload,
         d.idempotency_key, d.status, d.attempt_number,
         s.target_url, s.signing_secret_hash, s.active AS subscription_active
    FROM webhook_deliveries d
    JOIN webhook_subscriptions s ON s.id = d.subscription_id
   WHERE d.id = $1`;

// ─────────────────────────────────────────────────────────────────────────────
// The deliverer
// ─────────────────────────────────────────────────────────────────────────────

export class InProcessDeliverer implements IWebhookDeliverer {
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly db: Queryable;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(deps: DelivererDeps) {
    this.now = deps.now;
    this.fetchImpl = deps.fetch;
    this.db = deps.db ?? pool;
    this.random = deps.random ?? Math.random;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  }

  async deliverOnce(deliveryId: string): Promise<DeliveryAttempt | null> {
    const loaded = await this.db.query<DeliveryJoinRow>(DELIVERY_JOIN_SQL, [deliveryId]);
    const row = loaded.rows[0];
    if (!row) return null;
    if (row.status === 'succeeded' || row.status === 'dead_lettered') return null;

    // A subscription deactivated between enqueue and delivery (409 Gone on a
    // sibling delivery, or an operator disabling it) must not receive traffic.
    // The queued row is retired rather than left pending forever.
    if (!row.subscription_active) {
      return this.record(row, {
        attemptNumber: row.attempt_number,
        status: 'dead_lettered',
        responseStatus: null,
        responseExcerpt: null,
        latencyMs: 0,
        nextAttemptAtMs: null,
        scheduledDelayMs: null,
        error: 'subscription is inactive',
        subscriptionDeactivated: false,
      });
    }

    const attemptNumber = row.attempt_number + 1;
    // Serialize ONCE. This exact string is both signed and sent — see the note
    // in signature.ts about why re-serializing breaks verification.
    const rawBody = JSON.stringify(row.payload);
    const startedAt = this.now();
    const signatureHeader = signPayload(rawBody, row.signing_secret_hash, Math.floor(startedAt / 1000));
    const signedMaterial = { body: rawBody, header: signatureHeader };

    let response: Response | null = null;
    let transportError: string | null = null;

    const controller = new AbortController();
    const timer =
      this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();

    try {
      response = await this.fetchImpl(row.target_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Ship-Webhooks/1',
          [SIGNATURE_HEADER]: signatureHeader,
          [IDEMPOTENCY_HEADER]: row.idempotency_key,
          'Ship-Event-Id': row.event_id,
          'Ship-Event-Type': row.event_type,
          'Ship-Delivery-Id': row.id,
          'Ship-Delivery-Attempt': String(attemptNumber),
        },
        body: rawBody,
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (err) {
      transportError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const latencyMs = Math.max(0, this.now() - startedAt);

    if (!response) {
      // Network failure or timeout: transient by definition.
      return this.record(
        row,
        this.scheduleRetry(attemptNumber, null, transportError ?? 'transport error', latencyMs),
        signedMaterial
      );
    }

    const excerpt = await readExcerpt(response);
    const classification = classifyStatus(response.status);

    if (classification.disposition === 'success') {
      return this.record(row, {
        attemptNumber,
        status: 'succeeded',
        responseStatus: response.status,
        responseExcerpt: excerpt,
        latencyMs,
        nextAttemptAtMs: null,
        scheduledDelayMs: null,
        error: null,
        subscriptionDeactivated: false,
      }, signedMaterial);
    }

    if (classification.disposition === 'permanent') {
      if (classification.deactivateSubscription) {
        await this.db.query(`UPDATE webhook_subscriptions SET active = false WHERE id = $1`, [
          row.subscription_id,
        ]);
      }
      return this.record(row, {
        attemptNumber,
        status: 'dead_lettered',
        responseStatus: response.status,
        responseExcerpt: excerpt,
        latencyMs,
        nextAttemptAtMs: null,
        scheduledDelayMs: null,
        error: `permanent failure: HTTP ${response.status}`,
        subscriptionDeactivated: classification.deactivateSubscription,
      }, signedMaterial);
    }

    // Transient. 429 gets to name its own delay.
    const retryAfter =
      response.status === 429
        ? parseRetryAfter(response.headers.get('retry-after'), this.now())
        : null;
    const honored =
      retryAfter !== null && retryAfter >= 0 && retryAfter <= MAX_RETRY_AFTER_SECONDS
        ? retryAfter * 1000
        : null;

    return this.record(
      row,
      {
        ...this.scheduleRetry(attemptNumber, honored, `HTTP ${response.status}`, latencyMs),
        responseStatus: response.status,
        responseExcerpt: excerpt,
      }
    );
  }

  /** Decide "retry later" vs "give up", without touching the database. */
  private scheduleRetry(
    attemptNumber: number,
    overrideDelayMs: number | null,
    error: string,
    latencyMs: number
  ): Omit<DeliveryAttempt, 'deliveryId'> {
    if (attemptNumber >= this.maxAttempts) {
      return {
        attemptNumber,
        status: 'dead_lettered',
        responseStatus: null,
        responseExcerpt: null,
        latencyMs,
        nextAttemptAtMs: null,
        scheduledDelayMs: null,
        error: `${error} (gave up after ${attemptNumber} attempts)`,
        subscriptionDeactivated: false,
      };
    }
    const delay = overrideDelayMs ?? retryDelayMs(attemptNumber, this.random);
    return {
      attemptNumber,
      status: 'failed',
      responseStatus: null,
      responseExcerpt: null,
      latencyMs,
      nextAttemptAtMs: this.now() + delay,
      scheduledDelayMs: delay,
      error,
      subscriptionDeactivated: false,
    };
  }

  /**
   * One UPDATE per attempt. Every attempt is recorded — number, response
   * status, body excerpt, latency — because the delivery log is the ONLY
   * artifact a subscriber's engineer can look at when they say "we never got
   * it", and "we tried" without a status code and a latency is not an answer.
   */
  private async record(
    row: DeliveryJoinRow,
    outcome: Omit<DeliveryAttempt, 'deliveryId'>,
    /**
     * The EXACT string that was signed and the header it produced. Persisted
     * so a consumer reading the delivery log can verify the signature over the
     * same bytes we sent. Re-serializing `payload` would not reproduce them:
     * it is JSONB, and JSONB normalizes key order. Absent on attempts that
     * never got as far as signing.
     */
    signed?: { body: string; header: string }
  ): Promise<DeliveryAttempt> {
    const nowIso = new Date(this.now()).toISOString();
    await this.db.query(
      `UPDATE webhook_deliveries
          SET status = $2,
              attempt_number = $3,
              response_status = $4,
              response_excerpt = $5,
              latency_ms = $6,
              last_error = $7,
              next_attempt_at = COALESCE($8::timestamptz, next_attempt_at),
              delivered_at = CASE WHEN $2 = 'succeeded' THEN $9::timestamptz ELSE delivered_at END,
              signed_body = COALESCE($10, signed_body),
              signature_header = COALESCE($11, signature_header),
              updated_at = now()
        WHERE id = $1`,
      [
        row.id,
        outcome.status,
        outcome.attemptNumber,
        outcome.responseStatus,
        outcome.responseExcerpt,
        outcome.latencyMs,
        outcome.error,
        outcome.nextAttemptAtMs === null ? null : new Date(outcome.nextAttemptAtMs).toISOString(),
        nowIso,
        signed?.body ?? null,
        signed?.header ?? null,
      ]
    );
    return { deliveryId: row.id, ...outcome };
  }
}

/** Truncated response body. Never lets a subscriber's 5 MB HTML error page
 *  into the delivery log — and never lets its own failure fail the attempt. */
async function readExcerpt(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    return text.length > RESPONSE_EXCERPT_LIMIT ? `${text.slice(0, RESPONSE_EXCERPT_LIMIT)}…` : text;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The poller
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaimOptions {
  limit?: number;
  /** Injected "now" for due-ness. Defaults to the database's clock. */
  nowMs?: number;
}

/**
 * Atomically claim due deliveries.
 *
 * `FOR UPDATE SKIP LOCKED` inside the sub-select is what makes running two
 * pollers safe: the row is locked and flipped to 'delivering' in ONE
 * statement, so a second poller either blocks-then-skips (SKIP LOCKED) or sees
 * the already-updated status and does not match. There is no window between
 * "read the due rows" and "mark them mine" for a competitor to squeeze into —
 * which is exactly the window a naive SELECT-then-UPDATE leaves open, and the
 * reason double-delivery bugs are so common in hand-rolled outboxes.
 *
 * Deliveries whose subscription has been deactivated are not claimed at all.
 */
export async function claimDueDeliveries(
  db: Queryable,
  opts: ClaimOptions = {}
): Promise<string[]> {
  const limit = opts.limit ?? 20;
  const nowIso = opts.nowMs === undefined ? null : new Date(opts.nowMs).toISOString();
  const result = await db.query<{ id: string }>(
    `UPDATE webhook_deliveries d
        SET status = 'delivering', updated_at = now()
      WHERE d.id IN (
        SELECT c.id
          FROM webhook_deliveries c
          JOIN webhook_subscriptions s ON s.id = c.subscription_id
         WHERE c.status IN ('pending', 'failed')
           AND c.next_attempt_at <= COALESCE($2::timestamptz, now())
           AND s.active
         ORDER BY c.next_attempt_at
         LIMIT $1
         FOR UPDATE OF c SKIP LOCKED
      )
      RETURNING d.id`,
    [limit, nowIso]
  );
  return result.rows.map((r) => r.id);
}

export interface PollerOptions extends DelivererDeps {
  intervalMs?: number;
  batchSize?: number;
  deliverer?: IWebhookDeliverer;
  /** Drive due-ness from the injected clock instead of the database clock. */
  useInjectedClockForDueness?: boolean;
}

export interface PollerHandle {
  /** Run exactly one batch. Returns how many deliveries were attempted. */
  tick: () => Promise<number>;
  stop: () => void;
  readonly running: boolean;
}

/**
 * Start the background poller.
 *
 * A no-op when WEBHOOKS_ENABLED=false — the kill switch turns off delivery
 * end to end, not just publication. `tick()` is exposed so tests (and a future
 * admin "flush now" button) can drive a batch without waiting for an interval.
 */
export function startDeliveryPoller(opts: PollerOptions): PollerHandle {
  const db = opts.db ?? pool;
  const intervalMs = opts.intervalMs ?? 1_000;
  const batchSize = opts.batchSize ?? 20;
  const deliverer = opts.deliverer ?? new InProcessDeliverer(opts);
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<number> => {
    if (process.env.WEBHOOKS_ENABLED === 'false') return 0;
    // One batch at a time per process. Overlapping ticks would not corrupt
    // anything (the claim is atomic) but they would multiply connections
    // during an incident, which is the worst possible moment for that.
    if (inFlight) return 0;
    inFlight = true;
    try {
      const ids = await claimDueDeliveries(db, {
        limit: batchSize,
        nowMs: opts.useInjectedClockForDueness ? opts.now() : undefined,
      });
      for (const id of ids) {
        try {
          await deliverer.deliverOnce(id);
        } catch (err) {
          console.error(`[webhooks] delivery ${id} threw:`, err);
          // Leave it claimable again rather than stuck in 'delivering'.
          await db
            .query(
              `UPDATE webhook_deliveries
                  SET status = 'failed', last_error = $2, updated_at = now()
                WHERE id = $1 AND status = 'delivering'`,
              [id, err instanceof Error ? err.message : String(err)]
            )
            .catch(() => undefined);
        }
      }
      return ids.length;
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch((err) => console.error('[webhooks] poller tick failed:', err));
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    get running() {
      return !stopped;
    },
  };
}

/**
 * Requeue rows abandoned mid-flight by a crashed process.
 *
 * A row in 'delivering' whose owner died would otherwise sit there forever:
 * the claim query only looks at 'pending' and 'failed'. Called on poller
 * startup, which is the moment we know the previous process is gone.
 */
export async function requeueStuckDeliveries(
  db: Queryable = pool,
  staleAfterSeconds = 300
): Promise<number> {
  const result = await db.query<{ id: string }>(
    `UPDATE webhook_deliveries
        SET status = 'failed',
            last_error = COALESCE(last_error, 'reclaimed after delivering-state timeout'),
            updated_at = now()
      WHERE status = 'delivering'
        AND updated_at < now() - ($1 || ' seconds')::interval
      RETURNING id`,
    [String(staleAfterSeconds)]
  );
  return result.rowCount ?? result.rows.length;
}
