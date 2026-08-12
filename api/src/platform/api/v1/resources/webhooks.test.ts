/**
 * Public webhook resource tests. Real Postgres, per-test workspace, CASCADE
 * cleanup, no sleeps.
 *
 * The router here is assembled by hand rather than through `registerV1Routes`
 * because the route table is the orchestrator's to wire — this suite proves
 * the handlers, the scope gate, and the app scoping in exactly the middleware
 * order the route factory applies (tokenGate → requireScope → validate →
 * handler), so wiring them into routes.ts is the only remaining step.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import express, { Router } from 'express';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createV1Router } from '../router.js';
import { validate } from '../../../openapi/route-factory.js';
import { tokenGate } from '../middleware/authn.js';
import { requireScope } from '../middleware/scope.js';
import { buildEvent, idempotencyKeyFor } from '../../../webhooks/events.js';
import { deriveSigningKey } from '../../../webhooks/service.js';
import {
  CreateWebhookSubscriptionSchema,
  WebhookDeliveryListQuerySchema,
  WebhookIdParamSchema,
  WebhookSubscriptionListQuerySchema,
  handleCreateWebhookSubscription,
  handleDeleteWebhookSubscription,
  handleListWebhookDeliveries,
  handleListWebhookSubscriptions,
  handleReplayWebhookDelivery,
} from './webhooks.js';

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const runId = crypto.randomBytes(4).toString('hex');

let workspaceId: string;
let userId: string;
let appId: string;
let otherAppId: string;
let manageToken: string;
let readOnlyToken: string;
let personalToken: string;
let otherAppToken: string;
let tokenSeq = 0;

/** The same mounting the orchestrator will express through the route factory. */
function registerWebhookRoutes(router: Router): void {
  router.get(
    '/webhooks/deliveries',
    tokenGate,
    requireScope('webhooks:manage'),
    validate({ query: WebhookDeliveryListQuerySchema }),
    handleListWebhookDeliveries
  );
  router.post(
    '/webhooks/deliveries/:id/replay',
    tokenGate,
    requireScope('webhooks:manage'),
    validate({ params: WebhookIdParamSchema }),
    handleReplayWebhookDelivery
  );
  router.get(
    '/webhooks',
    tokenGate,
    requireScope('webhooks:manage'),
    validate({ query: WebhookSubscriptionListQuerySchema }),
    handleListWebhookSubscriptions
  );
  router.post(
    '/webhooks',
    tokenGate,
    requireScope('webhooks:manage'),
    validate({ body: CreateWebhookSubscriptionSchema }),
    handleCreateWebhookSubscription
  );
  router.delete(
    '/webhooks/:id',
    tokenGate,
    requireScope('webhooks:manage'),
    validate({ params: WebhookIdParamSchema }),
    handleDeleteWebhookSubscription
  );
}

const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', createV1Router(registerWebhookRoutes));
  return a;
};

async function mintToken(scopes: string[], oauthAppId: string | null): Promise<string> {
  const raw = `ship_${crypto.randomBytes(32).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, oauth_app_id, scopes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, workspaceId, `wh-token-${tokenSeq++}`, sha(raw), raw.slice(0, 8), oauthAppId, scopes]
  );
  return raw;
}

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

async function seedDelivery(subscriptionId: string): Promise<{ id: string; key: string }> {
  const event = buildEvent('issue.created', {
    id: crypto.randomUUID(),
    workspaceId,
    data: {
      issue_id: crypto.randomUUID(),
      title: 'Resource test issue',
      ticket_number: 3,
      state: 'backlog',
      priority: 'low',
      assignee_id: null,
    },
  });
  const key = idempotencyKeyFor(event);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO webhook_deliveries
       (subscription_id, event_id, event_type, payload, idempotency_key, status)
     VALUES ($1,$2,$3,$4::jsonb,$5,'dead_lettered')
     RETURNING id`,
    [subscriptionId, event.id, event.type, JSON.stringify(event), key]
  );
  return { id: res.rows[0]!.id, key };
}

async function createViaApi(overrides: Record<string, unknown> = {}) {
  return request(app())
    .post('/api/v1/webhooks')
    .set('Authorization', `Bearer ${manageToken}`)
    .send({
      event_type: 'issue.created',
      target_url: `https://hooks.test/${crypto.randomBytes(6).toString('hex')}`,
      ...overrides,
    });
}

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`W6 Webhook Routes ${runId}`]
  );
  workspaceId = ws.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1,'Webhook Route Tester') RETURNING id`,
    [`whroute-${runId}@ship.local`]
  );
  userId = user.rows[0]!.id;
  appId = await newApp('Webhook Route App');
  otherAppId = await newApp('Rival App');

  manageToken = await mintToken(['webhooks:manage'], appId);
  readOnlyToken = await mintToken(['documents:read'], appId);
  otherAppToken = await mintToken(['webhooks:manage'], otherAppId);
  personalToken = await mintToken(['webhooks:manage'], null);
});

afterAll(async () => {
  if (workspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM webhook_subscriptions WHERE app_id = ANY($1::uuid[])`, [
    [appId, otherAppId],
  ]);
});

describe('scope enforcement', () => {
  it('401s without a bearer token', async () => {
    const res = await request(app()).get('/api/v1/webhooks');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('403s and NAMES the missing scope', async () => {
    for (const path of ['/api/v1/webhooks', '/api/v1/webhooks/deliveries']) {
      const res = await request(app()).get(path).set('Authorization', `Bearer ${readOnlyToken}`);
      expect(res.status).toBe(403);
      expect(res.body.details.missing_scope).toBe('webhooks:manage');
    }
  });

  it('403s a personal access token — subscriptions belong to an app', async () => {
    const res = await request(app()).get('/api/v1/webhooks').set('Authorization', `Bearer ${personalToken}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/OAuth app/);
  });
});

describe('POST /api/v1/webhooks', () => {
  it('creates a subscription and returns the signing secret EXACTLY once', async () => {
    const res = await createViaApi();
    expect(res.status).toBe(201);
    expect(res.body.signing_secret).toMatch(/^ship_whsec_[0-9a-f]{64}$/);
    expect(res.body.secret_prefix).toHaveLength(8);
    expect(res.body.active).toBe(true);
    // Never cached, never resurfaced by a back button.
    expect(res.headers['cache-control']).toBe('no-store');

    // Only the derived key is at rest.
    const stored = await pool.query<{ signing_secret_hash: string }>(
      `SELECT signing_secret_hash FROM webhook_subscriptions WHERE id = $1`,
      [res.body.id]
    );
    expect(stored.rows[0]!.signing_secret_hash).toBe(deriveSigningKey(res.body.signing_secret));

    // And the list endpoint cannot produce it again.
    const list = await request(app()).get('/api/v1/webhooks').set('Authorization', `Bearer ${manageToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data[0].id).toBe(res.body.id);
    expect(list.body.data[0]).not.toHaveProperty('signing_secret');
    expect(JSON.stringify(list.body)).not.toContain(res.body.signing_secret);
  });

  it('400s on an unknown event type, listing what is valid', async () => {
    const res = await createViaApi({ event_type: 'issue.exploded' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
  });

  it('400s on a non-http target URL', async () => {
    const res = await createViaApi({ target_url: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
  });

  it('400s on a duplicate (event_type, target_url) for the same app', async () => {
    const url = 'https://hooks.test/dupe-route';
    expect((await createViaApi({ target_url: url })).status).toBe(201);
    const res = await createViaApi({ target_url: url });
    expect(res.status).toBe(400);
    expect(res.body.details.target_url).toBe(`${url}`);
  });
});

describe('GET /api/v1/webhooks', () => {
  it('lists only the calling app’s subscriptions', async () => {
    const mine = await createViaApi();
    const theirs = await request(app())
      .post('/api/v1/webhooks')
      .set('Authorization', `Bearer ${otherAppToken}`)
      .send({ event_type: 'issue.created', target_url: 'https://hooks.test/rival' });
    expect(theirs.status).toBe(201);

    const res = await request(app()).get('/api/v1/webhooks').set('Authorization', `Bearer ${manageToken}`);
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([mine.body.id]);
  });

  it('filters by event_type', async () => {
    await createViaApi({ event_type: 'issue.created' });
    const sprint = await createViaApi({ event_type: 'sprint.started' });
    const res = await request(app())
      .get('/api/v1/webhooks?event_type=sprint.started')
      .set('Authorization', `Bearer ${manageToken}`);
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([sprint.body.id]);
  });
});

describe('DELETE /api/v1/webhooks/:id', () => {
  it('deletes, then 404s, and never touches another app’s subscription', async () => {
    const created = await createViaApi();
    const id = created.body.id as string;

    const foreign = await request(app())
      .delete(`/api/v1/webhooks/${id}`)
      .set('Authorization', `Bearer ${otherAppToken}`);
    expect(foreign.status).toBe(404);

    const ok = await request(app())
      .delete(`/api/v1/webhooks/${id}`)
      .set('Authorization', `Bearer ${manageToken}`);
    expect(ok.status).toBe(204);

    const again = await request(app())
      .delete(`/api/v1/webhooks/${id}`)
      .set('Authorization', `Bearer ${manageToken}`);
    expect(again.status).toBe(404);
  });

  it('400s on a non-uuid id rather than reaching SQL', async () => {
    const res = await request(app())
      .delete('/api/v1/webhooks/not-a-uuid')
      .set('Authorization', `Bearer ${manageToken}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
  });
});

describe('GET /api/v1/webhooks/deliveries', () => {
  it('returns a cursor-paginated envelope scoped to the app', async () => {
    const created = await createViaApi();
    const seeded: string[] = [];
    for (let i = 0; i < 3; i += 1) seeded.push((await seedDelivery(created.body.id)).id);

    const first = await request(app())
      .get('/api/v1/webhooks/deliveries?limit=2')
      .set('Authorization', `Bearer ${manageToken}`);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.next_cursor).toBeTruthy();

    const second = await request(app())
      .get(`/api/v1/webhooks/deliveries?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`)
      .set('Authorization', `Bearer ${manageToken}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.next_cursor).toBeNull();

    const walked = [...first.body.data, ...second.body.data].map((d: { id: string }) => d.id);
    expect(new Set(walked).size).toBe(3);
    expect(walked.sort()).toEqual([...seeded].sort());

    // Another app sees none of them.
    const rival = await request(app())
      .get('/api/v1/webhooks/deliveries')
      .set('Authorization', `Bearer ${otherAppToken}`);
    expect(rival.body.data).toEqual([]);
  });

  it('filters by status and by subscription_id', async () => {
    const created = await createViaApi();
    const { id } = await seedDelivery(created.body.id);

    const byStatus = await request(app())
      .get('/api/v1/webhooks/deliveries?status=dead_lettered')
      .set('Authorization', `Bearer ${manageToken}`);
    expect(byStatus.body.data.map((d: { id: string }) => d.id)).toEqual([id]);

    const none = await request(app())
      .get('/api/v1/webhooks/deliveries?status=succeeded')
      .set('Authorization', `Bearer ${manageToken}`);
    expect(none.body.data).toEqual([]);

    const bySub = await request(app())
      .get(`/api/v1/webhooks/deliveries?subscription_id=${created.body.id}`)
      .set('Authorization', `Bearer ${manageToken}`);
    expect(bySub.body.data.map((d: { id: string }) => d.id)).toEqual([id]);
  });

  it('400s an undeclared status value at the schema, not in SQL', async () => {
    const res = await request(app())
      .get('/api/v1/webhooks/deliveries?status=exploded')
      .set('Authorization', `Bearer ${manageToken}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
  });
});

describe('POST /api/v1/webhooks/deliveries/:id/replay', () => {
  it('202s with a new delivery carrying the ORIGINAL idempotency key', async () => {
    const created = await createViaApi();
    const original = await seedDelivery(created.body.id);

    const res = await request(app())
      .post(`/api/v1/webhooks/deliveries/${original.id}/replay`)
      .set('Authorization', `Bearer ${manageToken}`);

    expect(res.status).toBe(202);
    expect(res.body.id).not.toBe(original.id);
    expect(res.body.idempotency_key).toBe(original.key);
    expect(res.body.replay_of_id).toBe(original.id);
    expect(res.body.status).toBe('pending');
  });

  it('404s for another app’s delivery — no cross-tenant existence oracle', async () => {
    const created = await createViaApi();
    const original = await seedDelivery(created.body.id);

    const foreign = await request(app())
      .post(`/api/v1/webhooks/deliveries/${original.id}/replay`)
      .set('Authorization', `Bearer ${otherAppToken}`);
    expect(foreign.status).toBe(404);

    const missing = await request(app())
      .post(`/api/v1/webhooks/deliveries/${crypto.randomUUID()}/replay`)
      .set('Authorization', `Bearer ${manageToken}`);
    expect(missing.status).toBe(404);
    // Byte-identical failure for "not yours" and "does not exist".
    expect(foreign.body.message).toBe(missing.body.message);
  });
});
