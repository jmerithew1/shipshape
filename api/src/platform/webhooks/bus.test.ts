/**
 * Event bus tests. Real Postgres, per-test workspace, CASCADE cleanup.
 *
 * The first test in this file is the one that protects the rest of the
 * codebase: with WEBHOOKS_ENABLED=false the bus must issue ZERO queries. Four
 * internal route suites mock `pool.query` with strict call sequences, and one
 * stray lookup from a publish hook would consume a mocked response and fail
 * tests in files that have nothing to do with webhooks.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { pool } from '../../db/client.js';
import { NoopEventBus, OutboxEventBus, getEventBus, webhooksEnabled, type Queryable } from './bus.js';
import { buildEvent, idempotencyKeyFor } from './events.js';

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const runId = crypto.randomBytes(4).toString('hex');

let workspaceId: string;
let otherWorkspaceId: string;
let userId: string;
let appId: string;

async function newSubscription(opts: {
  eventType: string;
  active?: boolean;
  workspaceId?: string;
  url?: string;
}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO webhook_subscriptions
       (app_id, workspace_id, event_type, target_url, signing_secret_hash, signing_secret_prefix, active)
     VALUES ($1,$2,$3,$4,$5,'abcd1234',$6)
     RETURNING id`,
    [
      appId,
      opts.workspaceId ?? workspaceId,
      opts.eventType,
      opts.url ?? `https://sub.test/${crypto.randomBytes(6).toString('hex')}`,
      sha('secret'),
      opts.active ?? true,
    ]
  );
  return res.rows[0]!.id;
}

function issueCreatedEvent(wsId: string = workspaceId) {
  return buildEvent('issue.created', {
    id: crypto.randomUUID(),
    workspaceId: wsId,
    data: {
      issue_id: crypto.randomUUID(),
      title: 'Bus test issue',
      ticket_number: 42,
      state: 'backlog',
      priority: 'medium',
      assignee_id: null,
    },
  });
}

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`W6 Bus ${runId}`]
  );
  workspaceId = ws.rows[0]!.id;

  const other = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`W6 Bus Other ${runId}`]
  );
  otherWorkspaceId = other.rows[0]!.id;

  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Bus Tester') RETURNING id`,
    [`bus-${runId}@ship.local`]
  );
  userId = user.rows[0]!.id;

  const app = await pool.query<{ id: string }>(
    `INSERT INTO oauth_apps (workspace_id, owner_user_id, name, client_id, client_secret_hash,
                             client_secret_prefix, redirect_uris, requested_scopes)
     VALUES ($1,$2,'Bus App',$3,$4,'ship_sec',ARRAY['https://example.test/cb'],ARRAY['webhooks:manage'])
     RETURNING id`,
    [workspaceId, userId, `ship_app_${crypto.randomBytes(8).toString('hex')}`, sha('s')]
  );
  appId = app.rows[0]!.id;
});

afterAll(async () => {
  process.env.WEBHOOKS_ENABLED = 'false';
  if (workspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (otherWorkspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [otherWorkspaceId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
});

beforeEach(async () => {
  // Subscriptions cascade from the workspace, but each case owns its own set.
  await pool.query(`DELETE FROM webhook_subscriptions WHERE app_id = $1`, [appId]);
  process.env.WEBHOOKS_ENABLED = 'true';
});

describe('the kill switch', () => {
  it('issues ZERO queries when WEBHOOKS_ENABLED=false', async () => {
    process.env.WEBHOOKS_ENABLED = 'false';
    const spy = { query: vi.fn() };
    const bus = new OutboxEventBus(spy as unknown as Queryable);

    await bus.publish(issueCreatedEvent());

    // Not "no rows inserted" — no query issued AT ALL. That is the contract
    // the strict pool.query mocks in the internal route suites depend on.
    expect(spy.query).not.toHaveBeenCalled();
  });

  it('is read per call, so flipping the flag takes effect without a restart', async () => {
    process.env.WEBHOOKS_ENABLED = 'false';
    expect(webhooksEnabled()).toBe(false);
    expect(getEventBus()).toBeInstanceOf(NoopEventBus);

    process.env.WEBHOOKS_ENABLED = 'true';
    expect(webhooksEnabled()).toBe(true);
    expect(getEventBus()).toBeInstanceOf(OutboxEventBus);
  });

  it('NoopEventBus swallows the event and issues nothing', async () => {
    const bus = new NoopEventBus();
    const event = issueCreatedEvent();
    await bus.publish(event);
    expect(bus.published).toEqual([event]);
  });
});

describe('OutboxEventBus fan-out', () => {
  it('inserts one delivery row per matching active subscription', async () => {
    const subA = await newSubscription({ eventType: 'issue.created' });
    const subB = await newSubscription({ eventType: 'issue.created' });

    const event = issueCreatedEvent();
    await new OutboxEventBus().publish(event);

    const rows = await pool.query<{ subscription_id: string; idempotency_key: string; status: string }>(
      `SELECT subscription_id, idempotency_key, status FROM webhook_deliveries WHERE event_id = $1`,
      [event.id]
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => r.subscription_id).sort()).toEqual([subA, subB].sort());
    for (const row of rows.rows) {
      expect(row.status).toBe('pending');
      // One key per EVENT, not per attempt — the whole dedupe contract.
      expect(row.idempotency_key).toBe(idempotencyKeyFor(event));
    }
  });

  it('inserts NOTHING for subscriptions on other event types', async () => {
    await newSubscription({ eventType: 'document.created' });
    await newSubscription({ eventType: 'sprint.started' });

    const event = issueCreatedEvent();
    await new OutboxEventBus().publish(event);

    const rows = await pool.query(`SELECT id FROM webhook_deliveries WHERE event_id = $1`, [event.id]);
    expect(rows.rows).toHaveLength(0);
  });

  it('skips inactive subscriptions', async () => {
    const active = await newSubscription({ eventType: 'issue.created' });
    await newSubscription({ eventType: 'issue.created', active: false });

    const event = issueCreatedEvent();
    await new OutboxEventBus().publish(event);

    const rows = await pool.query<{ subscription_id: string }>(
      `SELECT subscription_id FROM webhook_deliveries WHERE event_id = $1`,
      [event.id]
    );
    expect(rows.rows.map((r) => r.subscription_id)).toEqual([active]);
  });

  it('skips subscriptions belonging to another workspace', async () => {
    await newSubscription({ eventType: 'issue.created', workspaceId: otherWorkspaceId });
    const mine = await newSubscription({ eventType: 'issue.created' });

    const event = issueCreatedEvent();
    await new OutboxEventBus().publish(event);

    const rows = await pool.query<{ subscription_id: string }>(
      `SELECT subscription_id FROM webhook_deliveries WHERE event_id = $1`,
      [event.id]
    );
    expect(rows.rows.map((r) => r.subscription_id)).toEqual([mine]);
  });

  it('stores the full envelope as the payload', async () => {
    await newSubscription({ eventType: 'issue.created' });
    const event = issueCreatedEvent();
    await new OutboxEventBus().publish(event);

    const rows = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM webhook_deliveries WHERE event_id = $1`,
      [event.id]
    );
    expect(rows.rows[0]!.payload).toEqual(event);
  });

  it('rejects an unknown event type at the publish site', async () => {
    const bogus = { ...issueCreatedEvent(), type: 'issue.exploded' };
    await expect(
      new OutboxEventBus().publish(bogus as unknown as ReturnType<typeof issueCreatedEvent>)
    ).rejects.toThrow(/Unknown webhook event type/);
  });
});

describe('transactional publish', () => {
  it('rolls the delivery row back with the caller transaction (no phantom events)', async () => {
    await newSubscription({ eventType: 'issue.created' });
    const event = issueCreatedEvent();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await new OutboxEventBus().publish(event, client as unknown as Queryable);
      // The row exists inside the transaction…
      const inside = await client.query(`SELECT id FROM webhook_deliveries WHERE event_id = $1`, [
        event.id,
      ]);
      expect(inside.rows).toHaveLength(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // …and is gone once the domain write it belonged to rolls back.
    const after = await pool.query(`SELECT id FROM webhook_deliveries WHERE event_id = $1`, [event.id]);
    expect(after.rows).toHaveLength(0);
  });
});
