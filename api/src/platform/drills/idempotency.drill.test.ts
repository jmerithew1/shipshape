/**
 * DRILL: Idempotency-Key, end to end, against a subscriber that really dedupes.
 *
 * The assignment's words: "replay drill that confirms subscribers correctly
 * dedupe on replayed deliveries."
 *
 * WHAT MAKES THIS DIFFERENT FROM THE EXISTING TESTS
 * ------------------------------------------------
 * webhooks/service.test.ts already proves `replayDelivery` copies the source
 * row's `idempotency_key`. That is a statement about a column. It is not the
 * claim the platform actually makes to an integrator, which is:
 *
 *     "Delivery is at-least-once. Dedupe on Ship-Idempotency-Key and an
 *      operator clicking Replay will not create a second side effect."
 *
 * The only way to prove THAT is to put a real subscriber on the other end of a
 * real socket, give it a real dedupe table, and count its side effects. So this
 * drill stands up an HTTP server on an ephemeral port that:
 *
 *   - captures the raw request bytes (before any JSON parsing — the signature
 *     is over the bytes, and re-serializing breaks it)
 *   - verifies Ship-Signature with the key it derived from its own secret
 *   - keeps a set of keys it has already processed, and on a repeat returns
 *     200 WITHOUT running the side effect again
 *
 * The assertion the whole file exists for is at the end of the first case:
 * two HTTP requests arrive, both carry the SAME Ship-Idempotency-Key, and the
 * subscriber's side-effect count is exactly 1. Asserting only that the header
 * was copied would pass even if dedupe were impossible in practice.
 *
 * Isolation: one workspace, dropped by CASCADE in afterAll. No TRUNCATE. No
 * sleeps — every delivery is driven by an awaited `deliverOnce`, so there is
 * nothing to poll for and nothing to time out.
 *
 * Run it alone:
 *   pnpm --filter @ship/api exec vitest run src/platform/drills/idempotency.drill.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pool } from '../../db/client.js';
import { OutboxEventBus } from '../webhooks/bus.js';
import { InProcessDeliverer } from '../webhooks/deliverer.js';
import { buildEvent, idempotencyKeyFor, type ShipEvent } from '../webhooks/events.js';
import {
  createSubscription,
  deriveSigningKey,
  getDelivery,
  replayDelivery,
} from '../webhooks/service.js';
import { IDEMPOTENCY_HEADER, SIGNATURE_HEADER, verifySignature } from '../webhooks/signature.js';

const IDEMPOTENCY_HEADER_LC = IDEMPOTENCY_HEADER.toLowerCase();
const SIGNATURE_HEADER_LC = SIGNATURE_HEADER.toLowerCase();

// ── The subscriber ───────────────────────────────────────────────────────────

/** One inbound POST, exactly as the subscriber saw it. */
interface ReceivedRequest {
  idempotencyKey: string | null;
  signature: string | null;
  deliveryId: string | null;
  attempt: string | null;
  /** RAW bytes as received. Not parsed, not normalized. */
  rawBody: string;
  /** What the subscriber decided to do about it. */
  outcome: 'processed' | 'deduped' | 'rejected';
}

/**
 * A subscriber with a real dedupe table.
 *
 * `processedKeys` is the dedupe table; `sideEffects` is the thing an integrator
 * would actually care about not happening twice (a ticket filed, an email sent,
 * a row inserted). The distinction between "request received" and "side effect
 * run" is the entire point of the drill, so they are counted separately.
 */
class DedupingSubscriber {
  readonly received: ReceivedRequest[] = [];
  readonly sideEffects: Array<{ key: string; eventId: string }> = [];
  private readonly processedKeys = new Set<string>();
  private server: http.Server | null = null;
  url = '';

  constructor(private readonly rawSecret: string) {}

  get processedCount(): number {
    return this.sideEffects.length;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        // Capture the raw body BEFORE anything parses it. A subscriber that
        // lets its JSON middleware touch the body first cannot verify the
        // signature, because JSON.parse→JSON.stringify may reorder keys.
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const key = headerValue(req, IDEMPOTENCY_HEADER_LC);
        const signature = headerValue(req, SIGNATURE_HEADER_LC);

        const record = (outcome: ReceivedRequest['outcome']): void => {
          this.received.push({
            idempotencyKey: key,
            signature,
            deliveryId: headerValue(req, 'ship-delivery-id'),
            attempt: headerValue(req, 'ship-delivery-attempt'),
            rawBody,
            outcome,
          });
        };

        // Authenticate first. An unsigned or badly signed payload must never
        // reach the dedupe table, or an attacker could burn a key the real
        // delivery is about to use and suppress it.
        const verified = verifySignature(signature, rawBody, deriveSigningKey(this.rawSecret));
        if (!verified.ok || !key) {
          record('rejected');
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(verified.ok ? 'missing idempotency key' : verified.reason);
          return;
        }

        // THE DEDUPE. Seen this key before? Acknowledge and do nothing else.
        // 200 rather than 409: the delivery succeeded from Ship's point of
        // view — the subscriber has the event — and answering with an error
        // would make Ship retry a message that was already handled.
        if (this.processedKeys.has(key)) {
          record('deduped');
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('already processed');
          return;
        }

        this.processedKeys.add(key);
        const event = JSON.parse(rawBody) as ShipEvent;
        this.sideEffects.push({ key, eventId: event.id });
        record('processed');
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    this.server = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    // fetch keeps connections alive; without this, close() waits for them.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }
}

function headerValue(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let workspaceId: string;
let userId: string;
let appId: string;
let previousWebhooksEnabled: string | undefined;

/** Real global fetch, wrapped: a detached reference throws in some runtimes. */
const deliverer = new InProcessDeliverer({
  now: () => Date.now(),
  fetch: (input, init) => fetch(input, init),
});

const transcript: string[] = [];
let stepNumber = 0;

function step(line: string): void {
  stepNumber += 1;
  transcript.push(`  ${String(stepNumber).padStart(2, ' ')}. ${line}`);
}

function newDocumentEvent(): ShipEvent {
  return buildEvent('document.created', {
    id: crypto.randomUUID(),
    workspaceId,
    data: {
      document_id: crypto.randomUUID(),
      document_type: 'wiki',
      title: 'Idempotency drill document',
      parent_id: null,
    },
  });
}

/** The one delivery row this subscription has, newest first. */
async function deliveryIdsFor(subscriptionId: string): Promise<string[]> {
  const rows = await pool.query<{ id: string }>(
    `SELECT id FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY created_at, id`,
    [subscriptionId]
  );
  return rows.rows.map((r) => r.id);
}

beforeAll(async () => {
  // src/test/setup.ts pins WEBHOOKS_ENABLED=false so the kill switch keeps the
  // event bus out of the internal route suites' strict pool.query mocks. This
  // drill is about the bus, so it opts back in — and restores the flag after,
  // because vitest shares one process across files.
  previousWebhooksEnabled = process.env.WEBHOOKS_ENABLED;
  process.env.WEBHOOKS_ENABLED = 'true';

  const runId = crypto.randomBytes(4).toString('hex');

  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`W6 Idempotency Drill ${runId}`]
  );
  workspaceId = ws.rows[0]!.id;

  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Idempotency Drill Operator') RETURNING id`,
    [`idem-drill-${runId}@ship.local`]
  );
  userId = user.rows[0]!.id;

  const app = await pool.query<{ id: string }>(
    `INSERT INTO oauth_apps (workspace_id, owner_user_id, name, client_id, client_secret_hash,
                             client_secret_prefix, redirect_uris, requested_scopes)
     VALUES ($1,$2,$3,$4,$5,'ship_sec',ARRAY['https://drill.example.test/cb'],
             ARRAY['webhooks:manage'])
     RETURNING id`,
    [
      workspaceId,
      userId,
      `Idempotency Drill App ${runId}`,
      `ship_app_${crypto.randomBytes(8).toString('hex')}`,
      crypto.createHash('sha256').update('drill-secret').digest('hex'),
    ]
  );
  appId = app.rows[0]!.id;
});

afterAll(async () => {
  if (previousWebhooksEnabled === undefined) delete process.env.WEBHOOKS_ENABLED;
  else process.env.WEBHOOKS_ENABLED = previousWebhooksEnabled;

  if (workspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);

  if (transcript.length > 0) {
    console.log(
      ['', '── DRILL: replayed delivery → subscriber dedupes ──', ...transcript, ''].join('\n')
    );
  }
});

// ── The drill ────────────────────────────────────────────────────────────────

describe('DRILL — a replayed delivery reaches the subscriber twice and runs once', () => {
  it('carries one idempotency key across two deliveries and produces one side effect', async () => {
    const created = await createSubscription({
      appId,
      workspaceId,
      eventType: 'document.created',
      targetUrl: 'http://127.0.0.1:1/placeholder', // rewritten below to the live port
      createdBy: userId,
    });

    // The subscriber holds the RAW secret; Ship stored only sha256(raw) and
    // signs with that derived key. Standing the server up after createSubscription
    // is what lets the subscriber own the secret it was handed, exactly once.
    const subscriber = new DedupingSubscriber(created.rawSigningSecret);
    await subscriber.start();
    await pool.query(`UPDATE webhook_subscriptions SET target_url = $2 WHERE id = $1`, [
      created.subscription.id,
      subscriber.url,
    ]);
    step(`subscriber listening on ${subscriber.url} with its own signing secret`);

    try {
      // ── Publish. The outbox writes the delivery row; nothing is called yet.
      const event = newDocumentEvent();
      await new OutboxEventBus().publish(event);
      const expectedKey = idempotencyKeyFor(event);

      const [originalId, ...extra] = await deliveryIdsFor(created.subscription.id);
      expect(extra).toHaveLength(0); // one subscription, one delivery row
      expect(originalId).toBeTruthy();
      step(`publish ${event.type} → 1 pending delivery, key ${expectedKey}`);

      // ── First delivery. Driven directly rather than via the poller: the
      // poller claims every due row in the database, and this drill must
      // account for its OWN traffic, not whatever another suite left behind.
      const first = await deliverer.deliverOnce(originalId!);
      expect(first?.status).toBe('succeeded');
      expect(first?.responseStatus).toBe(200);
      expect(subscriber.received).toHaveLength(1);
      expect(subscriber.received[0]!.outcome).toBe('processed');
      expect(subscriber.processedCount).toBe(1);
      step(`deliver  → HTTP 200, subscriber PROCESSED (side effects: 1)`);

      // ── Replay through the service, exactly as the portal's button does.
      const replay = await replayDelivery({ id: originalId!, appId });
      expect(replay.id).not.toBe(originalId);
      // The replay is a NEW row pointing back at the original — the delivery
      // log stays append-only, so "what happened on the first attempt" is
      // still answerable after somebody clicks Replay.
      expect(replay.replay_of_id).toBe(originalId);
      expect(replay.idempotency_key).toBe(expectedKey);
      expect(replay.status).toBe('pending');
      step(`replay   → new delivery ${replay.id.slice(0, 8)}… replay_of_id=${originalId!.slice(0, 8)}…`);

      const second = await deliverer.deliverOnce(replay.id);
      expect(second?.status).toBe('succeeded');
      expect(second?.responseStatus).toBe(200);

      // ── THE ASSERTIONS THIS DRILL EXISTS FOR ──────────────────────────────
      // (a) the subscriber was really called twice — at-least-once is real,
      //     not something the replay quietly optimised away;
      expect(subscriber.received).toHaveLength(2);
      // (b) both requests carried the SAME key, so dedupe is even possible;
      expect(subscriber.received[0]!.idempotencyKey).toBe(expectedKey);
      expect(subscriber.received[1]!.idempotencyKey).toBe(expectedKey);
      // (c) and the side effect ran EXACTLY ONCE. This is the claim. A test
      //     that stopped at (b) would pass on a platform where dedupe is
      //     impossible in practice — it only proves a header was copied.
      expect(subscriber.processedCount).toBe(1);
      expect(subscriber.received[1]!.outcome).toBe('deduped');
      step(
        `RESULT: 2 requests received · 1 shared idempotency key · ` +
          `${subscriber.processedCount} side effect (second request deduped)`
      );

      // The two requests are distinguishable as deliveries even though they are
      // the same EVENT: different delivery ids, same key. That is what lets a
      // subscriber log both attempts while acting on one.
      expect(subscriber.received[0]!.deliveryId).toBe(originalId);
      expect(subscriber.received[1]!.deliveryId).toBe(replay.id);
      expect(subscriber.received[0]!.deliveryId).not.toBe(subscriber.received[1]!.deliveryId);

      // The bytes are identical across the replay. A replay that re-derived the
      // payload could deliver a DIFFERENT event under the same key, which is
      // strictly worse than not replaying at all.
      expect(subscriber.received[1]!.rawBody).toBe(subscriber.received[0]!.rawBody);

      // Both were authenticated — neither was waved through on a bad signature.
      for (const request of subscriber.received) {
        const verified = verifySignature(
          request.signature,
          request.rawBody,
          deriveSigningKey(created.rawSigningSecret)
        );
        expect(verified.ok).toBe(true);
      }

      // And the delivery log kept the exact signed bytes, so an integrator can
      // re-verify from the log rather than taking our word for it (migration 041).
      const logged = await getDelivery({ appId, id: replay.id });
      expect(logged?.signed_body).toBe(subscriber.received[1]!.rawBody);
      expect(logged?.signature_header).toBe(subscriber.received[1]!.signature);
      step(`log check: signed_body/signature_header on the replay row match the bytes sent`);
    } finally {
      await subscriber.stop();
    }
  });

  it('keeps deduping across a replay-of-a-replay, and still runs the effect once', async () => {
    const created = await createSubscription({
      appId,
      workspaceId,
      eventType: 'issue.created',
      targetUrl: 'http://127.0.0.1:1/placeholder',
      createdBy: userId,
    });
    const subscriber = new DedupingSubscriber(created.rawSigningSecret);
    await subscriber.start();
    await pool.query(`UPDATE webhook_subscriptions SET target_url = $2 WHERE id = $1`, [
      created.subscription.id,
      subscriber.url,
    ]);

    try {
      const event = buildEvent('issue.created', {
        id: crypto.randomUUID(),
        workspaceId,
        data: {
          issue_id: crypto.randomUUID(),
          title: 'Idempotency drill issue',
          ticket_number: 1,
          state: 'open',
          priority: null,
          assignee_id: null,
        },
      });
      await new OutboxEventBus().publish(event);
      const expectedKey = idempotencyKeyFor(event);

      const [originalId] = await deliveryIdsFor(created.subscription.id);
      await deliverer.deliverOnce(originalId!);

      const firstReplay = await replayDelivery({ id: originalId!, appId });
      await deliverer.deliverOnce(firstReplay.id);
      const secondReplay = await replayDelivery({ id: firstReplay.id, appId });
      await deliverer.deliverOnce(secondReplay.id);

      // The chain is walkable — replay-of-a-replay points at its own parent…
      expect(firstReplay.replay_of_id).toBe(originalId);
      expect(secondReplay.replay_of_id).toBe(firstReplay.id);
      // …while the key is inherited from the EVENT, not from the parent row, so
      // it survives arbitrarily many hops.
      expect(secondReplay.idempotency_key).toBe(expectedKey);

      expect(subscriber.received).toHaveLength(3);
      expect(new Set(subscriber.received.map((r) => r.idempotencyKey))).toEqual(
        new Set([expectedKey])
      );
      expect(subscriber.processedCount).toBe(1);
      expect(subscriber.received.map((r) => r.outcome)).toEqual([
        'processed',
        'deduped',
        'deduped',
      ]);
      step(`replay-of-replay: 3 requests · 1 key · ${subscriber.processedCount} side effect`);
    } finally {
      await subscriber.stop();
    }
  });

  it('shows what a subscriber WITHOUT dedupe would have suffered', async () => {
    // The control case. Same platform, same replay, same key — the only thing
    // removed is the subscriber's dedupe table. If this case did not double,
    // the passing cases above would be proving nothing about the subscriber.
    const created = await createSubscription({
      appId,
      workspaceId,
      eventType: 'sprint.started',
      targetUrl: 'http://127.0.0.1:1/placeholder',
      createdBy: userId,
    });

    const naiveEffects: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        // No key check at all: process everything that arrives.
        naiveEffects.push(headerValue(req, IDEMPOTENCY_HEADER_LC) ?? '');
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });

    try {
      const port = (server.address() as AddressInfo).port;
      await pool.query(`UPDATE webhook_subscriptions SET target_url = $2 WHERE id = $1`, [
        created.subscription.id,
        `http://127.0.0.1:${port}/hook`,
      ]);

      const event = buildEvent('sprint.started', {
        id: crypto.randomUUID(),
        workspaceId,
        data: {
          sprint_id: crypto.randomUUID(),
          title: 'Idempotency drill sprint',
          start_date: null,
          end_date: null,
        },
      });
      await new OutboxEventBus().publish(event);

      const [originalId] = await deliveryIdsFor(created.subscription.id);
      await deliverer.deliverOnce(originalId!);
      const replay = await replayDelivery({ id: originalId!, appId });
      await deliverer.deliverOnce(replay.id);

      // Two side effects from one event. The platform behaved identically; the
      // difference is entirely on the subscriber's side, which is precisely why
      // the contract is documented as at-least-once rather than exactly-once.
      expect(naiveEffects).toHaveLength(2);
      expect(new Set(naiveEffects).size).toBe(1); // same key, ignored twice
      step(`control: subscriber without dedupe ran the effect ${naiveEffects.length}× on 1 event`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
