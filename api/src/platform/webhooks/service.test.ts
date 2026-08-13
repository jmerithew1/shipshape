/**
 * Subscription + delivery-log service tests. Real Postgres, per-test
 * workspace, CASCADE cleanup, no TRUNCATE, no sleeps.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import { pool } from '../../db/client.js';
import { buildEvent, idempotencyKeyFor } from './events.js';
import {
  SIGNING_SECRET_PREFIX,
  WebhookServiceError,
  createSubscription,
  deleteSubscription,
  deriveSigningKey,
  getDelivery,
  getSubscription,
  listDeliveries,
  listSubscriptions,
  replayDelivery,
  setSubscriptionActive,
} from './service.js';

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const runId = crypto.randomBytes(4).toString('hex');

let workspaceId: string;
let otherWorkspaceId: string;
let userId: string;
let appId: string;
let otherAppId: string;

async function newApp(name: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO oauth_apps (workspace_id, owner_user_id, name, client_id, client_secret_hash,
                             client_secret_prefix, redirect_uris, requested_scopes)
     VALUES ($1,$2,$3,$4,$5,'ship_sec',ARRAY['https://example.test/cb'],ARRAY['webhooks:manage'])
     RETURNING id`,
    [workspaceId, userId, name, `ship_app_${crypto.randomBytes(8).toString('hex')}`, sha('s')]
  );
  return res.rows[0]!.id;
}

async function seedDelivery(
  subscriptionId: string,
  opts: { status?: string; createdAt?: string } = {}
): Promise<{ id: string; idempotencyKey: string }> {
  const event = buildEvent('document.created', {
    id: crypto.randomUUID(),
    workspaceId,
    data: {
      document_id: crypto.randomUUID(),
      document_type: 'wiki',
      title: 'Service test doc',
      parent_id: null,
    },
  });
  const key = idempotencyKeyFor(event);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO webhook_deliveries
       (subscription_id, event_id, event_type, payload, idempotency_key, status, created_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6, COALESCE($7::timestamptz, now()))
     RETURNING id`,
    [
      subscriptionId,
      event.id,
      event.type,
      JSON.stringify(event),
      key,
      opts.status ?? 'pending',
      opts.createdAt ?? null,
    ]
  );
  return { id: res.rows[0]!.id, idempotencyKey: key };
}

const create = (overrides: Partial<Parameters<typeof createSubscription>[0]> = {}) =>
  createSubscription({
    appId,
    workspaceId,
    eventType: 'issue.created',
    targetUrl: `https://hooks.test/${crypto.randomBytes(6).toString('hex')}`,
    createdBy: userId,
    ...overrides,
  });

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`W6 Webhook Service ${runId}`]
  );
  workspaceId = ws.rows[0]!.id;
  const ws2 = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`W6 Webhook Service Other ${runId}`]
  );
  otherWorkspaceId = ws2.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1,'Webhook Service Tester') RETURNING id`,
    [`whsvc-${runId}@ship.local`]
  );
  userId = user.rows[0]!.id;
  appId = await newApp('Webhook Service App');
  otherAppId = await newApp('Someone Elses App');
});

afterAll(async () => {
  if (workspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (otherWorkspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [otherWorkspaceId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM webhook_subscriptions WHERE app_id = ANY($1::uuid[])`, [
    [appId, otherAppId],
  ]);
});

describe('createSubscription', () => {
  it('returns the raw signing secret ONCE and stores only its hash', async () => {
    const { subscription, rawSigningSecret } = await create();

    expect(rawSigningSecret.startsWith(SIGNING_SECRET_PREFIX)).toBe(true);
    expect(rawSigningSecret.slice(SIGNING_SECRET_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);

    const stored = await pool.query<{ signing_secret_hash: string; signing_secret_prefix: string }>(
      `SELECT signing_secret_hash, signing_secret_prefix FROM webhook_subscriptions WHERE id = $1`,
      [subscription.id]
    );
    const row = stored.rows[0]!;
    expect(row.signing_secret_hash).toBe(deriveSigningKey(rawSigningSecret));
    expect(row.signing_secret_hash).not.toBe(rawSigningSecret);
    // The raw value appears nowhere in the row.
    expect(JSON.stringify(row)).not.toContain(rawSigningSecret);

    // The identifying prefix is 8 characters of the RANDOM BODY, not of the
    // `ship_whsec_` tag every subscription shares.
    expect(row.signing_secret_prefix).toHaveLength(8);
    expect(row.signing_secret_prefix).toBe(
      rawSigningSecret.slice(SIGNING_SECRET_PREFIX.length, SIGNING_SECRET_PREFIX.length + 8)
    );
    expect(row.signing_secret_prefix).not.toBe('ship_whs');
  });

  it('never leaks the hash through the public view', async () => {
    const { subscription } = await create();
    expect(Object.keys(subscription)).not.toContain('signing_secret_hash');
    expect(subscription.secret_prefix).toHaveLength(8);
    expect(subscription.active).toBe(true);
  });

  it('mints a different secret for every subscription', async () => {
    const a = await create();
    const b = await create();
    expect(a.rawSigningSecret).not.toBe(b.rawSigningSecret);
  });

  it('rejects an unknown event type with the known list attached', async () => {
    await expect(create({ eventType: 'issue.exploded' })).rejects.toMatchObject({
      code: 'unknown_event_type',
    });
    const err = await create({ eventType: 'issue.exploded' }).catch((e: WebhookServiceError) => e);
    expect((err as WebhookServiceError).details?.known_event_types).toContain('issue.created');
  });

  it('rejects a non-absolute or non-http target URL', async () => {
    for (const bad of ['/relative/path', 'ftp://files.test/hook', 'javascript:alert(1)', 'nonsense']) {
      await expect(create({ targetUrl: bad })).rejects.toMatchObject({ code: 'invalid_target_url' });
    }
  });

  it('rejects a duplicate (app, event_type, target_url) triple', async () => {
    const url = 'https://hooks.test/duplicate';
    await create({ targetUrl: url });
    await expect(create({ targetUrl: url })).rejects.toMatchObject({
      code: 'duplicate_subscription',
    });
    // …but the same URL for a DIFFERENT event type is legitimate.
    await expect(create({ targetUrl: url, eventType: 'issue.assigned' })).resolves.toBeTruthy();
  });
});

describe('listing and deleting subscriptions', () => {
  it('lists only the calling app’s subscriptions', async () => {
    const mine = await create();
    await createSubscription({
      appId: otherAppId,
      workspaceId,
      eventType: 'issue.created',
      targetUrl: 'https://hooks.test/theirs',
    });

    const listed = await listSubscriptions({ appId, workspaceId });
    expect(listed.map((s) => s.id)).toEqual([mine.subscription.id]);
  });

  it('filters by event type', async () => {
    await create({ eventType: 'issue.created' });
    const sprint = await create({ eventType: 'sprint.started' });
    const listed = await listSubscriptions({ appId, workspaceId, eventType: 'sprint.started' });
    expect(listed.map((s) => s.id)).toEqual([sprint.subscription.id]);
  });

  it('refuses to delete another app’s subscription', async () => {
    const { subscription } = await create();
    expect(await deleteSubscription({ appId: otherAppId, workspaceId, id: subscription.id })).toBe(
      false
    );
    expect(await deleteSubscription({ appId, workspaceId, id: subscription.id })).toBe(true);
    expect(await deleteSubscription({ appId, workspaceId, id: subscription.id })).toBe(false);
  });

  it('deactivates without deleting (the 410 path and the portal toggle)', async () => {
    const { subscription } = await create();
    expect(await setSubscriptionActive({ id: subscription.id, active: false })).toBe(true);
    const [listed] = await listSubscriptions({ appId, workspaceId });
    expect(listed!.active).toBe(false);
  });
});

describe('listDeliveries', () => {
  it('returns only deliveries belonging to the calling app', async () => {
    const mine = await create();
    const theirs = await createSubscription({
      appId: otherAppId,
      workspaceId,
      eventType: 'issue.created',
      targetUrl: 'https://hooks.test/theirs',
    });
    const mineDelivery = await seedDelivery(mine.subscription.id);
    await seedDelivery(theirs.subscription.id);

    const page = await listDeliveries({ appId, workspaceId });
    expect(page.data.map((d) => d.id)).toEqual([mineDelivery.id]);
  });

  it('filters by subscription and by status', async () => {
    const a = await create();
    const b = await create();
    const pending = await seedDelivery(a.subscription.id, { status: 'pending' });
    const dead = await seedDelivery(a.subscription.id, { status: 'dead_lettered' });
    await seedDelivery(b.subscription.id, { status: 'pending' });

    const bySub = await listDeliveries({ appId, workspaceId, subscriptionId: a.subscription.id });
    expect(bySub.data.map((d) => d.id).sort()).toEqual([pending.id, dead.id].sort());

    const byStatus = await listDeliveries({ appId, workspaceId, status: 'dead_lettered' });
    expect(byStatus.data.map((d) => d.id)).toEqual([dead.id]);
  });

  it('rejects an unknown status rather than silently returning everything', async () => {
    await expect(listDeliveries({ appId, workspaceId, status: 'exploded' })).rejects.toBeInstanceOf(
      WebhookServiceError
    );
  });

  it('paginates by keyset cursor with no repeats and no gaps', async () => {
    const { subscription } = await create();
    const seeded: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      seeded.push((await seedDelivery(subscription.id, { createdAt: created })).id);
    }

    const first = await listDeliveries({ appId, workspaceId, limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();

    const second = await listDeliveries({ appId, workspaceId, limit: 2, cursor: first.next_cursor! });
    const third = await listDeliveries({ appId, workspaceId, limit: 2, cursor: second.next_cursor! });
    expect(third.next_cursor).toBeNull();

    const walked = [...first.data, ...second.data, ...third.data].map((d) => d.id);
    expect(new Set(walked).size).toBe(5);
    expect([...walked].sort()).toEqual([...seeded].sort());
    // Newest first, matching every other v1 list — and the cursor walk
    // preserves that order across page boundaries.
    expect(walked).toEqual([...seeded].reverse());
  });

  it('rejects a tampered cursor', async () => {
    await expect(listDeliveries({ appId, workspaceId, cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(
      WebhookServiceError
    );
  });
});

describe('replayDelivery', () => {
  it('creates a NEW row carrying the original idempotency key and pointing back at the source', async () => {
    const { subscription } = await create();
    const original = await seedDelivery(subscription.id, { status: 'dead_lettered' });

    const replay = await replayDelivery({ id: original.id, appId, workspaceId });
    expect(replay.id).not.toBe(original.id);
    expect(replay.idempotency_key).toBe(original.idempotencyKey);
    expect(replay.replay_of_id).toBe(original.id);
    expect(replay.status).toBe('pending');
    expect(replay.attempt_number).toBe(0);
    expect(replay.delivered_at).toBeNull();

    // The payload rides along verbatim — a replay must deliver what the
    // original was going to deliver, not a re-derived version of it.
    const payloads = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM webhook_deliveries WHERE id = ANY($1::uuid[])`,
      [[original.id, replay.id]]
    );
    expect(payloads.rows[0]!.payload).toEqual(payloads.rows[1]!.payload);
  });

  it('supports replaying a replay, forming a walkable chain', async () => {
    const { subscription } = await create();
    const original = await seedDelivery(subscription.id, { status: 'dead_lettered' });
    const first = await replayDelivery({ id: original.id, appId, workspaceId });
    const second = await replayDelivery({ id: first.id, appId, workspaceId });

    expect(second.replay_of_id).toBe(first.id);
    expect(second.idempotency_key).toBe(original.idempotencyKey);
  });

  it('404s for another app’s delivery — no cross-tenant existence oracle', async () => {
    const { subscription } = await create();
    const original = await seedDelivery(subscription.id);
    await expect(replayDelivery({ id: original.id, appId: otherAppId })).rejects.toMatchObject({
      code: 'not_found',
    });
    // Identical failure for an id that does not exist at all.
    await expect(replayDelivery({ id: crypto.randomUUID(), appId })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('exposes the replay through the same delivery log', async () => {
    const { subscription } = await create();
    const original = await seedDelivery(subscription.id);
    const replay = await replayDelivery({ id: original.id, appId, workspaceId });
    const fetched = await getDelivery({ appId, workspaceId, id: replay.id });
    expect(fetched?.replay_of_id).toBe(original.id);
    expect(await getDelivery({ appId: otherAppId, workspaceId, id: replay.id })).toBeNull();
  });
});

// Regression (security scan, HIGH / CWE-863). An OAuth app can be authorized in
// many workspaces, so the SAME app_id spans tenants — the token's workspace_id
// is the real isolation boundary. These management queries used to scope by
// app_id ALONE, so a token for the app in workspace B could read, delete, and
// replay workspace A's subscriptions and delivery payloads. Every query now
// filters on (app_id, workspace_id), mirroring the fan-out path in bus.ts.
describe('cross-workspace isolation for a shared OAuth app', () => {
  // The victim's subscription + delivery live under `appId` in `workspaceId`.
  // The attacker holds a token for the SAME `appId` but in `otherWorkspaceId`.
  it('hides another workspace’s subscriptions and deliveries from a same-app token', async () => {
    const victim = await create(); // appId, workspaceId
    const victimDelivery = await seedDelivery(victim.subscription.id);

    // The attacker (same app, different workspace) sees nothing.
    expect(await listSubscriptions({ appId, workspaceId: otherWorkspaceId })).toEqual([]);
    expect(
      await getSubscription({ appId, workspaceId: otherWorkspaceId, id: victim.subscription.id })
    ).toBeNull();
    expect((await listDeliveries({ appId, workspaceId: otherWorkspaceId })).data).toEqual([]);
    expect(
      await getDelivery({ appId, workspaceId: otherWorkspaceId, id: victimDelivery.id })
    ).toBeNull();

    // …cannot delete it (row survives)…
    expect(
      await deleteSubscription({ appId, workspaceId: otherWorkspaceId, id: victim.subscription.id })
    ).toBe(false);
    expect(
      await getSubscription({ appId, workspaceId, id: victim.subscription.id })
    ).not.toBeNull();

    // …and cannot replay it (same 404 as a non-existent row — no cross-tenant oracle).
    await expect(
      replayDelivery({ id: victimDelivery.id, appId, workspaceId: otherWorkspaceId })
    ).rejects.toMatchObject({ code: 'not_found' });

    // The legitimate owner (same app, correct workspace) still can do all of it.
    expect((await listSubscriptions({ appId, workspaceId })).map((s) => s.id)).toContain(
      victim.subscription.id
    );
    expect((await listDeliveries({ appId, workspaceId })).data.map((d) => d.id)).toContain(
      victimDelivery.id
    );
    const replay = await replayDelivery({ id: victimDelivery.id, appId, workspaceId });
    expect(replay.replay_of_id).toBe(victimDelivery.id);
  });
});
