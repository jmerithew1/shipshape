/**
 * Liskov substitutability of `IEventBus`.
 *
 * The brief: *"in-process must-ship; a queue-backed implementation is a
 * Liskov-substitutable drop-in."* That was recorded as satisfied on the
 * strength of an interface existing, which proves nothing — an interface admits
 * any implementation that type-checks, and LSP is about BEHAVIOUR, not shape.
 *
 * These tests do two things. First they demonstrate a real queue-backed
 * substitute driving the same domain path with the same observable outcome.
 * Second — and this is the part worth having — they pin down the ONE contract
 * clause a queue-backed implementation can silently violate, and prove that
 * violating it is detectable rather than a matter of opinion.
 *
 * THE CONSTRAINT. `publish(event, client?)` takes an optional transaction
 * client, and the outbox's whole value is that delivery rows commit or roll
 * back WITH the domain write. A queue-backed bus is naturally tempted to
 * enqueue in memory and drain later, out of band. Do that while a client was
 * passed, and the domain write can roll back while the event still ships — a
 * phantom event for a document that never existed. That is a strengthened
 * precondition in LSP terms: the substitute demands "no transaction, please"
 * where the base type accepted one.
 *
 * So the interface does not merely admit a queue-backed implementation; it
 * admits one that honours the passed client. `DeferredQueueBus` below does.
 * `NaiveQueueBus` does not, and the final test proves the difference is
 * observable — which is what makes this a check rather than a claim.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import { pool } from '../../db/client.js';
import { OutboxEventBus, type IEventBus, type Queryable } from './bus.js';
import { buildEvent } from './events.js';

let workspaceId: string;
let appId: string;

async function newSubscription(eventType: string): Promise<void> {
  await pool.query(
    `INSERT INTO webhook_subscriptions
       (app_id, workspace_id, event_type, target_url, signing_secret_hash,
        signing_secret_prefix, active, created_by)
     VALUES ($1, $2, $3, 'https://example.com/hook', 'hash', 'whsec', true, NULL)`,
    [appId, workspaceId, eventType]
  );
}

function documentCreated() {
  return buildEvent('document.created', {
    id: crypto.randomUUID(),
    workspaceId,
    data: {
      document_id: crypto.randomUUID(),
      document_type: 'wiki',
      title: 'liskov',
      parent_id: null,
    },
  });
}

const deliveriesFor = async (eventId: string) =>
  (await pool.query(`SELECT id FROM webhook_deliveries WHERE event_id = $1`, [eventId])).rows;

/**
 * A queue-backed bus that honours the caller's transaction.
 *
 * Enqueues rather than writing through, exactly as a real queue-backed
 * implementation would — but retains the client it was handed, so `drain()`
 * writes on that same connection and stays inside the caller's transaction.
 * This is the shape a production queue-backed bus has to take to remain
 * substitutable here.
 */
class DeferredQueueBus implements IEventBus {
  private queue: Array<{ event: ReturnType<typeof documentCreated>; client?: Queryable }> = [];
  private readonly inner = new OutboxEventBus();

  async publish(event: ReturnType<typeof documentCreated>, client?: Queryable): Promise<void> {
    this.queue.push({ event, client });
  }

  /** Flush. A real implementation drains on commit hook or worker tick. */
  async drain(): Promise<void> {
    const pending = this.queue;
    this.queue = [];
    for (const { event, client } of pending) await this.inner.publish(event, client);
  }
}

/** The tempting-but-wrong version: drops the client and writes on the pool. */
class NaiveQueueBus implements IEventBus {
  private queue: Array<ReturnType<typeof documentCreated>> = [];
  private readonly inner = new OutboxEventBus();

  async publish(event: ReturnType<typeof documentCreated>): Promise<void> {
    this.queue.push(event);
  }

  async drain(): Promise<void> {
    const pending = this.queue;
    this.queue = [];
    for (const event of pending) await this.inner.publish(event); // no client — escapes the txn
  }
}

beforeAll(async () => {
  // Global setup disables webhook publication (setup.ts); webhook suites
  // re-enable it explicitly, same as bus.test.ts.
  process.env.WEBHOOKS_ENABLED = 'true';
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`Liskov WS ${crypto.randomUUID().slice(0, 8)}`]
  );
  workspaceId = ws.rows[0]!.id;
  const app = await pool.query<{ id: string }>(
    `INSERT INTO oauth_apps
       (workspace_id, owner_user_id, name, client_id, client_secret_hash,
        client_secret_prefix, redirect_uris, requested_scopes, is_first_party)
     VALUES ($1, NULL, 'Liskov App', $2, 'h', 'ship_sec',
             ARRAY['https://example.com/cb'], ARRAY['webhooks:manage'], false)
     RETURNING id`,
    [workspaceId, `ship_app_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`]
  );
  appId = app.rows[0]!.id;
});

afterAll(async () => {
  process.env.WEBHOOKS_ENABLED = 'false';
  await pool.query(`DELETE FROM webhook_subscriptions WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM oauth_apps WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM webhook_subscriptions WHERE workspace_id = $1`, [workspaceId]);
});

describe('IEventBus — a queue-backed implementation is substitutable', () => {
  it('produces the same delivery rows as the in-process bus for the same input', async () => {
    await newSubscription('document.created');

    const direct = documentCreated();
    await new OutboxEventBus().publish(direct);

    const queued = documentCreated();
    const bus = new DeferredQueueBus();
    await bus.publish(queued);
    // Nothing written yet — deferral is the whole point of being queue-backed.
    expect(await deliveriesFor(queued.id)).toHaveLength(0);
    await bus.drain();

    expect(await deliveriesFor(queued.id)).toHaveLength(
      (await deliveriesFor(direct.id)).length
    );
    expect(await deliveriesFor(queued.id)).toHaveLength(1);
  });

  it('does not strengthen preconditions — it rejects exactly what the base type rejects', async () => {
    // `as unknown as` deliberately: the point is to hand the substitute an
    // envelope the registry does not know, which the type system correctly
    // refuses to construct directly.
    const bogus = { ...documentCreated(), type: 'document.exploded' } as unknown as ReturnType<
      typeof documentCreated
    >;
    const bus = new DeferredQueueBus();
    await bus.publish(bogus);

    // The base type throws at the publish site for an unknown event type. A
    // substitute that swallowed it would be accepting MORE than the base and
    // hiding a bug; one that threw earlier would be accepting LESS.
    await expect(bus.drain()).rejects.toThrow();
  });

  it('honours the caller transaction, so a rolled-back write ships no event', async () => {
    await newSubscription('document.created');
    const event = documentCreated();
    const bus = new DeferredQueueBus();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await bus.publish(event, client as unknown as Queryable);
      await bus.drain(); // drains ON the caller's client
      expect(
        (await client.query(`SELECT id FROM webhook_deliveries WHERE event_id = $1`, [event.id]))
          .rows
      ).toHaveLength(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(await deliveriesFor(event.id)).toHaveLength(0);
  });

  it('CONTROL: a queue-backed bus that drops the client BREAKS the guarantee, observably', async () => {
    await newSubscription('document.created');
    const event = documentCreated();
    const bus = new NaiveQueueBus();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await bus.publish(event);
      await client.query('ROLLBACK'); // the domain write is abandoned
    } finally {
      client.release();
    }
    await bus.drain(); // …and the event ships anyway

    // A phantom event: a delivery for a document that never committed. This is
    // the failure the passed client exists to prevent, and the reason the
    // interface's optional `client` is load-bearing rather than convenience.
    // Without this control the previous test could pass for the wrong reason —
    // e.g. if nothing was ever written at all.
    expect(await deliveriesFor(event.id)).toHaveLength(1);
  });
});
