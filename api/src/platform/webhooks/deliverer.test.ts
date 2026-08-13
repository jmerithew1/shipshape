/**
 * Deliverer tests — the retry ladder, the dead-letter queue, replay, and the
 * poller's claim.
 *
 * THERE IS NO SLEEP IN THIS FILE, and no `setTimeout` anywhere in a test body.
 * Time is a `let` that only the test moves. The whole 1s/4s/16s ladder is
 * exercised in single-digit milliseconds, and the assertions are arithmetic on
 * recorded timestamps rather than observations of elapsed wall-clock — so
 * these tests cannot flake on a loaded CI box, which is the entire point of
 * putting `now` and `fetch` on the constructor.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import { pool } from '../../db/client.js';
import type { Queryable } from './bus.js';
import { buildEvent, idempotencyKeyFor } from './events.js';
import {
  InProcessDeliverer,
  JITTER_RATIO,
  MAX_ATTEMPTS,
  RETRY_SCHEDULE_MS,
  claimDueDeliveries,
  classifyStatus,
  parseRetryAfter,
  requeueStuckDeliveries,
  retryDelayMs,
  startDeliveryPoller,
} from './deliverer.js';
import { replayDelivery } from './service.js';
import { verifySignature } from './signature.js';

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const runId = crypto.randomBytes(4).toString('hex');
const SECRET_KEY = sha('deliverer-test-secret');

let workspaceId: string;
let userId: string;
let appId: string;

// ── Virtual clock ────────────────────────────────────────────────────────────

function makeClock(startMs: number) {
  let t = startMs;
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

// ── Scripted transport ───────────────────────────────────────────────────────

type Reply = { status: number; body?: string; headers?: Record<string, string> };

interface Transport {
  fetch: typeof fetch;
  calls: { url: string; headers: Record<string, string>; body: string }[];
  queue: (Reply | Error)[];
}

function makeTransport(queue: (Reply | Error)[], fallback?: Reply): Transport {
  const calls: Transport['calls'] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k] = v;
    }
    calls.push({ url: String(input), headers, body: String(init?.body ?? '') });
    const next = queue.shift() ?? fallback ?? { status: 200, body: 'ok' };
    if (next instanceof Error) throw next;
    return new Response(next.body ?? '', { status: next.status, headers: next.headers });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, queue };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function newSubscription(opts: { eventType?: string; url?: string } = {}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO webhook_subscriptions
       (app_id, workspace_id, event_type, target_url, signing_secret_hash, signing_secret_prefix)
     VALUES ($1,$2,$3,$4,$5,'abcd1234')
     RETURNING id`,
    [
      appId,
      workspaceId,
      opts.eventType ?? 'issue.created',
      opts.url ?? `https://subscriber.test/${crypto.randomBytes(6).toString('hex')}`,
      SECRET_KEY,
    ]
  );
  return res.rows[0]!.id;
}

function sampleEvent() {
  return buildEvent('issue.created', {
    id: crypto.randomUUID(),
    workspaceId,
    data: {
      issue_id: crypto.randomUUID(),
      title: 'Deliverer test issue',
      ticket_number: 7,
      state: 'backlog',
      priority: 'high',
      assignee_id: null,
    },
  });
}

async function newDelivery(
  subscriptionId: string,
  opts: { nextAttemptAt?: string } = {}
): Promise<{ id: string; event: ReturnType<typeof sampleEvent> }> {
  const event = sampleEvent();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO webhook_deliveries
       (subscription_id, event_id, event_type, payload, idempotency_key, next_attempt_at)
     VALUES ($1,$2,$3,$4::jsonb,$5, COALESCE($6::timestamptz, now()))
     RETURNING id`,
    [
      subscriptionId,
      event.id,
      event.type,
      JSON.stringify(event),
      idempotencyKeyFor(event),
      opts.nextAttemptAt ?? null,
    ]
  );
  return { id: res.rows[0]!.id, event };
}

interface DeliveryState {
  status: string;
  attempt_number: number;
  response_status: number | null;
  response_excerpt: string | null;
  latency_ms: number | null;
  last_error: string | null;
  next_attempt_at: Date;
  delivered_at: Date | null;
  idempotency_key: string;
  replay_of_id: string | null;
}

async function readDelivery(id: string): Promise<DeliveryState> {
  const res = await pool.query<DeliveryState>(
    `SELECT status, attempt_number, response_status, response_excerpt, latency_ms,
            last_error, next_attempt_at, delivered_at, idempotency_key, replay_of_id
       FROM webhook_deliveries WHERE id = $1`,
    [id]
  );
  return res.rows[0]!;
}

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`W6 Deliverer ${runId}`]
  );
  workspaceId = ws.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1,'Deliverer Tester') RETURNING id`,
    [`deliverer-${runId}@ship.local`]
  );
  userId = user.rows[0]!.id;
  const app = await pool.query<{ id: string }>(
    `INSERT INTO oauth_apps (workspace_id, owner_user_id, name, client_id, client_secret_hash,
                             client_secret_prefix, redirect_uris, requested_scopes)
     VALUES ($1,$2,'Deliverer App',$3,$4,'ship_sec',ARRAY['https://example.test/cb'],ARRAY['webhooks:manage'])
     RETURNING id`,
    [workspaceId, userId, `ship_app_${crypto.randomBytes(8).toString('hex')}`, sha('s')]
  );
  appId = app.rows[0]!.id;
});

afterAll(async () => {
  if (workspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM webhook_subscriptions WHERE app_id = $1`, [appId]);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the retry schedule as data', () => {
  it('is exactly 1s, 4s, 16s, 1m, 5m, 30m', () => {
    expect([...RETRY_SCHEDULE_MS]).toEqual([1_000, 4_000, 16_000, 60_000, 300_000, 1_800_000]);
  });

  it('caps attempts at 6', () => {
    expect(MAX_ATTEMPTS).toBe(6);
  });

  it('jitters upward only — every delay is at least its base', () => {
    for (let attempt = 1; attempt <= RETRY_SCHEDULE_MS.length; attempt += 1) {
      const base = RETRY_SCHEDULE_MS[attempt - 1]!;
      expect(retryDelayMs(attempt, () => 0)).toBe(base);
      expect(retryDelayMs(attempt, () => 0.999)).toBeGreaterThanOrEqual(base);
      expect(retryDelayMs(attempt, () => 0.999)).toBeLessThanOrEqual(base * (1 + JITTER_RATIO));
      // 200 random draws, none below the floor. The floor is the promise.
      for (let i = 0; i < 200; i += 1) {
        expect(retryDelayMs(attempt)).toBeGreaterThanOrEqual(base);
      }
    }
  });

  it('repeats the last step past the end of the ladder instead of returning undefined', () => {
    const last = RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1]!;
    expect(retryDelayMs(99, () => 0)).toBe(last);
  });
});

describe('status classification', () => {
  it('treats 5xx as transient and 4xx as permanent', () => {
    expect(classifyStatus(500).disposition).toBe('transient');
    expect(classifyStatus(503).disposition).toBe('transient');
    expect(classifyStatus(400).disposition).toBe('permanent');
    expect(classifyStatus(401).disposition).toBe('permanent');
    expect(classifyStatus(404).disposition).toBe('permanent');
  });

  it('carves out 408 and 429 as the two transient 4xx codes', () => {
    expect(classifyStatus(408).disposition).toBe('transient');
    expect(classifyStatus(429).disposition).toBe('transient');
  });

  it('marks 410 permanent AND deactivating', () => {
    expect(classifyStatus(410)).toEqual({ disposition: 'permanent', deactivateSubscription: true });
  });

  it('accepts any 2xx as an acknowledgement', () => {
    for (const s of [200, 201, 202, 204, 299]) expect(classifyStatus(s).disposition).toBe('success');
  });

  it('parses Retry-After in both delta-seconds and HTTP-date form', () => {
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe('THE RETRY LADDER (injected clock, zero real waiting)', () => {
  it('waits ≥1s, ≥4s, ≥16s after failures 1–3 and records success on attempt 4', async () => {
    const subId = await newSubscription();
    const { id: deliveryId } = await newDelivery(subId);

    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const transport = makeTransport([
      { status: 500, body: 'boom' },
      { status: 500, body: 'boom' },
      { status: 503, body: 'still boom' },
      { status: 200, body: 'ok' },
    ]);
    const deliverer = new InProcessDeliverer({
      now: clock.now,
      fetch: transport.fetch,
      timeoutMs: 0,
    });

    const scheduledWaits: number[] = [];
    const recordedWaits: number[] = [];

    for (let i = 0; i < 4; i += 1) {
      const attemptAt = clock.now();
      const outcome = await deliverer.deliverOnce(deliveryId);
      expect(outcome).not.toBeNull();

      const row = await readDelivery(deliveryId);
      expect(row.attempt_number).toBe(i + 1);

      if (outcome!.nextAttemptAtMs !== null) {
        scheduledWaits.push(outcome!.nextAttemptAtMs - attemptAt);
        // The wait as PERSISTED, not merely as returned — the poller reads the
        // row, so the row is what actually governs the next attempt.
        recordedWaits.push(row.next_attempt_at.getTime() - attemptAt);
        // Virtual time jumps straight to when the poller would fire. No sleep.
        clock.advance(outcome!.nextAttemptAtMs - attemptAt);
      }
    }

    expect(transport.calls).toHaveLength(4);
    expect(scheduledWaits).toHaveLength(3);

    expect(scheduledWaits[0]).toBeGreaterThanOrEqual(1_000);
    expect(scheduledWaits[1]).toBeGreaterThanOrEqual(4_000);
    expect(scheduledWaits[2]).toBeGreaterThanOrEqual(16_000);

    expect(recordedWaits[0]).toBeGreaterThanOrEqual(1_000);
    expect(recordedWaits[1]).toBeGreaterThanOrEqual(4_000);
    expect(recordedWaits[2]).toBeGreaterThanOrEqual(16_000);

    // Jitter is bounded above too, or the ladder would be meaningless.
    expect(scheduledWaits[0]).toBeLessThanOrEqual(1_000 * (1 + JITTER_RATIO));
    expect(scheduledWaits[1]).toBeLessThanOrEqual(4_000 * (1 + JITTER_RATIO));
    expect(scheduledWaits[2]).toBeLessThanOrEqual(16_000 * (1 + JITTER_RATIO));

    // Attempt 4 is the one that succeeded, and the log says so.
    const final = await readDelivery(deliveryId);
    expect(final.status).toBe('succeeded');
    expect(final.attempt_number).toBe(4);
    expect(final.response_status).toBe(200);
    expect(final.response_excerpt).toBe('ok');
    expect(final.delivered_at).not.toBeNull();
  });

  it('follows the exact base schedule when jitter is pinned to zero', async () => {
    const subId = await newSubscription();
    const { id: deliveryId } = await newDelivery(subId);
    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const deliverer = new InProcessDeliverer({
      now: clock.now,
      fetch: makeTransport([], { status: 500 }).fetch,
      random: () => 0,
      timeoutMs: 0,
    });

    const waits: number[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const at = clock.now();
      const outcome = await deliverer.deliverOnce(deliveryId);
      if (outcome!.nextAttemptAtMs !== null) {
        waits.push(outcome!.nextAttemptAtMs - at);
        clock.advance(outcome!.nextAttemptAtMs - at);
      }
    }
    // Five waits for six attempts; the sixth failure dead-letters instead of
    // scheduling the ladder's 30m tail.
    expect(waits).toEqual([...RETRY_SCHEDULE_MS].slice(0, MAX_ATTEMPTS - 1));
  });

  it('records attempt number, status, excerpt and latency on every attempt', async () => {
    const subId = await newSubscription();
    const { id: deliveryId } = await newDelivery(subId);
    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const transport = makeTransport([{ status: 500, body: 'x'.repeat(2_000) }]);
    const deliverer = new InProcessDeliverer({
      now: clock.now,
      // Latency is measured off the injected clock, so the test states it.
      fetch: (async (...args: Parameters<typeof fetch>) => {
        clock.advance(137);
        return transport.fetch(...args);
      }) as typeof fetch,
      timeoutMs: 0,
    });

    await deliverer.deliverOnce(deliveryId);
    const row = await readDelivery(deliveryId);
    expect(row.attempt_number).toBe(1);
    expect(row.status).toBe('failed');
    expect(row.latency_ms).toBe(137);
    expect(row.last_error).toContain('500');
  });

  it('truncates a long response body to ~500 characters', async () => {
    const subId = await newSubscription();
    const { id: deliveryId } = await newDelivery(subId);
    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const deliverer = new InProcessDeliverer({
      now: clock.now,
      fetch: makeTransport([{ status: 400, body: 'y'.repeat(5_000) }]).fetch,
      timeoutMs: 0,
    });
    await deliverer.deliverOnce(deliveryId);
    const row = await readDelivery(deliveryId);
    expect(row.response_excerpt!.length).toBeLessThanOrEqual(501);
    expect(row.response_excerpt!.endsWith('…')).toBe(true);
  });

  it('signs the exact bytes it sends, and the subscriber can verify them', async () => {
    const subId = await newSubscription();
    const { id: deliveryId, event } = await newDelivery(subId);
    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const transport = makeTransport([{ status: 200, body: 'ok' }]);
    await new InProcessDeliverer({ now: clock.now, fetch: transport.fetch, timeoutMs: 0 }).deliverOnce(
      deliveryId
    );

    const call = transport.calls[0]!;
    const nowSeconds = Math.floor(clock.now() / 1000);
    expect(
      verifySignature(call.headers['Ship-Signature'], call.body, SECRET_KEY, 300, nowSeconds).ok
    ).toBe(true);
    expect(call.headers['Ship-Idempotency-Key']).toBe(idempotencyKeyFor(event));
    expect(call.headers['Ship-Event-Type']).toBe('issue.created');
    expect(call.headers['Ship-Delivery-Attempt']).toBe('1');
  });

  it('treats a transport error (timeout, DNS, refused) as transient', async () => {
    const subId = await newSubscription();
    const { id: deliveryId } = await newDelivery(subId);
    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const deliverer = new InProcessDeliverer({
      now: clock.now,
      fetch: makeTransport([Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })])
        .fetch,
      random: () => 0,
      timeoutMs: 0,
    });

    const outcome = await deliverer.deliverOnce(deliveryId);
    expect(outcome!.status).toBe('failed');
    expect(outcome!.scheduledDelayMs).toBe(1_000);
    const row = await readDelivery(deliveryId);
    expect(row.last_error).toContain('AbortError');
  });
});

describe('DEAD-LETTER AND REPLAY', () => {
  it('dead-letters after 6 consecutive failures, then replays successfully with the SAME idempotency key', async () => {
    const subId = await newSubscription();
    const { id: originalId, event } = await newDelivery(subId);

    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const failing = makeTransport([], { status: 500, body: 'down' });
    const deliverer = new InProcessDeliverer({
      now: clock.now,
      fetch: failing.fetch,
      random: () => 0,
      timeoutMs: 0,
    });

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const at = clock.now();
      const outcome = await deliverer.deliverOnce(originalId);
      if (outcome!.nextAttemptAtMs !== null) clock.advance(outcome!.nextAttemptAtMs - at);
    }

    const dead = await readDelivery(originalId);
    expect(dead.status).toBe('dead_lettered');
    expect(dead.attempt_number).toBe(MAX_ATTEMPTS);
    expect(dead.last_error).toContain('gave up after 6 attempts');
    expect(failing.calls).toHaveLength(MAX_ATTEMPTS);

    // Regression (audit sweep): a delivery that dead-letters purely on transient
    // 5xx must still carry the exact signed bytes. The transient branch used to
    // drop them, so tail could not verify the very failures an operator most
    // wants to inspect.
    const signed = await pool.query<{ signed_body: string | null; signature_header: string | null }>(
      `SELECT signed_body, signature_header FROM webhook_deliveries WHERE id = $1`,
      [originalId]
    );
    expect(signed.rows[0]!.signed_body).not.toBeNull();
    expect(signed.rows[0]!.signature_header).toMatch(/^t=\d+,v1=/);

    // A dead-lettered delivery is inert: further attempts do nothing.
    expect(await deliverer.deliverOnce(originalId)).toBeNull();
    expect(failing.calls).toHaveLength(MAX_ATTEMPTS);

    // ── The subscriber is fixed. An operator replays. ──
    const replay = await replayDelivery({ id: originalId, appId });
    expect(replay.id).not.toBe(originalId);
    expect(replay.status).toBe('pending');
    expect(replay.attempt_number).toBe(0);
    expect(replay.replay_of_id).toBe(originalId);
    // Regression (audit sweep): the freshly-enqueued replay has not been signed
    // yet, so these are null — but they must be PRESENT as null, not dropped.
    // The replay RETURNING clause used to omit both columns, so toDeliveryView
    // emitted `undefined` and the required-nullable contract field vanished.
    expect(replay.signed_body).toBeNull();
    expect(replay.signature_header).toBeNull();
    // THE contract: one key, one processed side effect, N delivery rows.
    expect(replay.idempotency_key).toBe(dead.idempotency_key);
    expect(replay.idempotency_key).toBe(idempotencyKeyFor(event));

    const healthy = makeTransport([{ status: 200, body: 'thanks' }]);
    const replayDeliverer = new InProcessDeliverer({
      now: clock.now,
      fetch: healthy.fetch,
      timeoutMs: 0,
    });
    const outcome = await replayDeliverer.deliverOnce(replay.id);
    expect(outcome!.status).toBe('succeeded');

    const replayed = await readDelivery(replay.id);
    expect(replayed.status).toBe('succeeded');
    expect(replayed.attempt_number).toBe(1);
    expect(replayed.idempotency_key).toBe(dead.idempotency_key);
    expect(healthy.calls[0]!.headers['Ship-Idempotency-Key']).toBe(dead.idempotency_key);

    // The original row is untouched history — a rewritable log is not a log.
    const originalAfter = await readDelivery(originalId);
    expect(originalAfter.status).toBe('dead_lettered');
    expect(originalAfter.attempt_number).toBe(MAX_ATTEMPTS);
  });
});

describe('permanent vs transient failures', () => {
  it('dead-letters a 4xx IMMEDIATELY with no retries', async () => {
    const subId = await newSubscription();
    const { id: deliveryId } = await newDelivery(subId);
    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const transport = makeTransport([], { status: 404, body: 'no such hook' });
    const deliverer = new InProcessDeliverer({ now: clock.now, fetch: transport.fetch, timeoutMs: 0 });

    const outcome = await deliverer.deliverOnce(deliveryId);
    expect(outcome!.status).toBe('dead_lettered');
    expect(outcome!.attemptNumber).toBe(1);
    expect(outcome!.nextAttemptAtMs).toBeNull();

    const row = await readDelivery(deliveryId);
    expect(row.status).toBe('dead_lettered');
    expect(row.attempt_number).toBe(1);
    expect(row.response_status).toBe(404);

    // Not retried, ever: one HTTP call total.
    expect(await deliverer.deliverOnce(deliveryId)).toBeNull();
    expect(transport.calls).toHaveLength(1);
  });

  it('RETRIES a 429 and honors Retry-After', async () => {
    const subId = await newSubscription();
    const { id: deliveryId } = await newDelivery(subId);
    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const deliverer = new InProcessDeliverer({
      now: clock.now,
      fetch: makeTransport([{ status: 429, body: 'slow down', headers: { 'Retry-After': '120' } }])
        .fetch,
      random: () => 0,
      timeoutMs: 0,
    });

    const outcome = await deliverer.deliverOnce(deliveryId);
    expect(outcome!.status).toBe('failed');
    expect(outcome!.responseStatus).toBe(429);
    // 120s, not the ladder's 1s: the subscriber named its own delay.
    expect(outcome!.scheduledDelayMs).toBe(120_000);
    const row = await readDelivery(deliveryId);
    expect(row.next_attempt_at.getTime() - clock.now()).toBe(120_000);
  });

  it('falls back to the ladder when a 429 sends no Retry-After', async () => {
    const subId = await newSubscription();
    const { id: deliveryId } = await newDelivery(subId);
    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const deliverer = new InProcessDeliverer({
      now: clock.now,
      fetch: makeTransport([{ status: 429, body: 'slow down' }]).fetch,
      random: () => 0,
      timeoutMs: 0,
    });
    const outcome = await deliverer.deliverOnce(deliveryId);
    expect(outcome!.scheduledDelayMs).toBe(1_000);
  });

  it('RETRIES a 408 like a 5xx', async () => {
    const subId = await newSubscription();
    const { id: deliveryId } = await newDelivery(subId);
    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const deliverer = new InProcessDeliverer({
      now: clock.now,
      fetch: makeTransport([{ status: 408 }]).fetch,
      random: () => 0,
      timeoutMs: 0,
    });
    const outcome = await deliverer.deliverOnce(deliveryId);
    expect(outcome!.status).toBe('failed');
    expect(outcome!.scheduledDelayMs).toBe(1_000);
  });

  it('DEACTIVATES the subscription on 410 Gone', async () => {
    const subId = await newSubscription();
    const { id: deliveryId } = await newDelivery(subId);
    const { id: siblingId } = await newDelivery(subId);
    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const deliverer = new InProcessDeliverer({
      now: clock.now,
      fetch: makeTransport([{ status: 410, body: 'gone' }]).fetch,
      timeoutMs: 0,
    });

    const outcome = await deliverer.deliverOnce(deliveryId);
    expect(outcome!.status).toBe('dead_lettered');
    expect(outcome!.subscriptionDeactivated).toBe(true);

    const sub = await pool.query<{ active: boolean }>(
      `SELECT active FROM webhook_subscriptions WHERE id = $1`,
      [subId]
    );
    expect(sub.rows[0]!.active).toBe(false);

    // And the queue drains rather than piling up dead letters forever: the
    // sibling is retired without another call to the dead endpoint.
    const before = await pool.query<{ id: string }>(
      `SELECT id FROM webhook_deliveries WHERE id = $1 AND status = 'pending'`,
      [siblingId]
    );
    expect(before.rows).toHaveLength(1);
    const siblingOutcome = await deliverer.deliverOnce(siblingId);
    expect(siblingOutcome!.status).toBe('dead_lettered');
    expect(siblingOutcome!.error).toContain('inactive');
  });
});

describe('the poller claim', () => {
  it('CONCURRENCY: two pollers can never claim the same delivery row', async () => {
    const subId = await newSubscription();
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push((await newDelivery(subId)).id);

    // Two independent connections, both claiming at the same instant. This is
    // the scenario SKIP LOCKED exists for; a SELECT-then-UPDATE would hand the
    // same row to both and double-deliver.
    const a = await pool.connect();
    const b = await pool.connect();
    const claims: string[][] = [];
    try {
      claims.push(
        ...(await Promise.all([
          claimDueDeliveries(a as unknown as Queryable, { limit: 6 }),
          claimDueDeliveries(b as unknown as Queryable, { limit: 6 }),
        ]))
      );
    } finally {
      a.release();
      b.release();
    }

    const all = claims.flat();
    expect(new Set(all).size).toBe(all.length); // no id claimed twice
    expect(all.sort()).toEqual([...ids].sort()); // and none lost

    // A third claim finds nothing: the rows are 'delivering' now.
    expect(await claimDueDeliveries(pool, { limit: 6 })).toEqual([]);
  });

  it('does not claim rows that are not due yet', async () => {
    const subId = await newSubscription();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await newDelivery(subId, { nextAttemptAt: future });
    const due = await newDelivery(subId);

    expect(await claimDueDeliveries(pool, { limit: 10 })).toEqual([due.id]);
  });

  it('does not claim rows whose subscription has been deactivated', async () => {
    const subId = await newSubscription();
    await newDelivery(subId);
    await pool.query(`UPDATE webhook_subscriptions SET active = false WHERE id = $1`, [subId]);
    expect(await claimDueDeliveries(pool, { limit: 10 })).toEqual([]);
  });

  it('requeues rows abandoned in "delivering" by a crashed process', async () => {
    const subId = await newSubscription();
    const { id } = await newDelivery(subId);
    await pool.query(
      `UPDATE webhook_deliveries SET status = 'delivering', updated_at = now() - interval '1 hour'
        WHERE id = $1`,
      [id]
    );
    expect(await claimDueDeliveries(pool, { limit: 10 })).toEqual([]);

    const requeued = await requeueStuckDeliveries(pool, 300);
    expect(requeued).toBeGreaterThanOrEqual(1);
    expect(await claimDueDeliveries(pool, { limit: 10 })).toEqual([id]);
  });

  it('tick() claims and delivers a batch, and is a no-op when the kill switch is off', async () => {
    const subId = await newSubscription();
    const { id } = await newDelivery(subId);
    const clock = makeClock(Date.UTC(2026, 7, 12, 12, 0, 0));
    const transport = makeTransport([], { status: 200, body: 'ok' });
    const poller = startDeliveryPoller({
      now: clock.now,
      fetch: transport.fetch,
      timeoutMs: 0,
      intervalMs: 1_000_000, // the interval never fires inside this test
    });

    try {
      process.env.WEBHOOKS_ENABLED = 'false';
      expect(await poller.tick()).toBe(0);
      expect(transport.calls).toHaveLength(0);

      process.env.WEBHOOKS_ENABLED = 'true';
      expect(await poller.tick()).toBe(1);
      expect((await readDelivery(id)).status).toBe('succeeded');
    } finally {
      process.env.WEBHOOKS_ENABLED = 'false';
      poller.stop();
    }
  });
});
