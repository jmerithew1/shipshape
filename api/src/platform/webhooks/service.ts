/**
 * Webhook subscription and delivery-log service.
 *
 * SECRETS ARE SHOWN ONCE. `createSubscription` returns the raw signing secret
 * in its result and nowhere else — there is no endpoint, no query, and no log
 * line that can produce it again. What is stored is `sha256(raw)` plus an
 * 8-character identifying prefix, the same shape `oauth_apps.client_secret`
 * uses, so there is exactly one credential-at-rest story in this codebase.
 * Losing the secret means rotating the subscription, which is a deliberate
 * cost: a secret that can be re-read is a secret in every log aggregator.
 *
 * THE DERIVED-KEY TRADEOFF, STATED PLAINLY. Because the raw secret is not
 * recoverable, the deliverer cannot sign with it. It signs with the stored
 * sha256 — the DERIVED KEY — and subscribers verify with
 * `deriveSigningKey(rawSecret)` (the SDK's one-call verifier does this for
 * them). The consequence is honest and worth saying out loud: the stored value
 * is a signing key, so a database dump lets an attacker FORGE webhooks to that
 * subscriber. It does not let them replay Ship credentials anywhere else, and
 * it does not expose the raw secret the operator holds. The alternative —
 * storing the raw secret so the signature is over an unrecoverable key —
 * trades forgeability-after-dump for readability-in-every-dump, which is
 * strictly worse. The real fix is an envelope-encrypted secret in a KMS, which
 * is a Week-N decision, not a Week-6 one.
 *
 * REPLAY CARRIES THE ORIGINAL IDEMPOTENCY KEY. `replayDelivery` copies the
 * source row's `idempotency_key` in the same INSERT that reads it, so the two
 * values cannot drift — no application code ever holds the key. That is the
 * whole subscriber contract: delivery is at-least-once, dedupe on the key, and
 * an operator clicking "replay" must not create a second side effect.
 */
import { pool } from '../../db/client.js';
import { sha256Hex } from '../oauth/service.js';
import crypto from 'node:crypto';
import { buildPage, clampPageSize, decodeCursor, keysetClause, type Page } from '../api/v1/pagination.js';
import type { Queryable } from './bus.js';
import { EVENT_TYPES, assertKnownEventType, type ShipEventType } from './events.js';

/** Self-describing credential tag, matching the `ship_*` family. */
export const SIGNING_SECRET_PREFIX = 'ship_whsec_';

export const DELIVERY_STATUSES = [
  'pending',
  'delivering',
  'succeeded',
  'failed',
  'dead_lettered',
] as const;
export type DeliveryStatusFilter = (typeof DELIVERY_STATUSES)[number];

/**
 * The HMAC key both sides use. Exported (and re-exported by the SDK) so the
 * derivation is written down exactly once — a subscriber that hashes with a
 * different encoding gets a signature mismatch and no clue why.
 */
export function deriveSigningKey(rawSecret: string): string {
  return sha256Hex(rawSecret);
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type WebhookErrorCode =
  | 'unknown_event_type'
  | 'invalid_target_url'
  | 'duplicate_subscription'
  | 'not_found';

/**
 * A domain error with a code. The service does not import ApiError: it knows
 * nothing about HTTP, and the v1 handlers own the mapping from code to status.
 * That is what lets the same service back the portal, the CLI, and a future
 * internal admin surface without three copies of the rules.
 */
export class WebhookServiceError extends Error {
  constructor(
    public readonly code: WebhookErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'WebhookServiceError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows and views
// ─────────────────────────────────────────────────────────────────────────────

export interface SubscriptionRow {
  id: string;
  app_id: string;
  workspace_id: string;
  event_type: string;
  target_url: string;
  signing_secret_hash: string;
  signing_secret_prefix: string;
  active: boolean;
  created_by: string | null;
  created_at: Date | string;
}

/** The public shape. Note what is absent: the hash never leaves this module. */
export interface SubscriptionView {
  id: string;
  event_type: string;
  target_url: string;
  active: boolean;
  secret_prefix: string;
  created_at: string;
}

export interface DeliveryRow {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  idempotency_key: string;
  status: string;
  attempt_number: number;
  response_status: number | null;
  response_excerpt: string | null;
  signed_body: string | null;
  signature_header: string | null;
  latency_ms: number | null;
  last_error: string | null;
  replay_of_id: string | null;
  next_attempt_at: Date | string;
  created_at: Date | string;
  delivered_at: Date | string | null;
}

export interface DeliveryView {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  idempotency_key: string;
  status: string;
  attempt_number: number;
  response_status: number | null;
  response_excerpt: string | null;
  signed_body: string | null;
  signature_header: string | null;
  latency_ms: number | null;
  last_error: string | null;
  replay_of_id: string | null;
  next_attempt_at: string;
  created_at: string;
  delivered_at: string | null;
}

const asIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

export function toSubscriptionView(row: SubscriptionRow): SubscriptionView {
  return {
    id: row.id,
    event_type: row.event_type,
    target_url: row.target_url,
    active: row.active,
    secret_prefix: row.signing_secret_prefix,
    created_at: asIso(row.created_at),
  };
}

export function toDeliveryView(row: DeliveryRow): DeliveryView {
  return {
    id: row.id,
    subscription_id: row.subscription_id,
    event_id: row.event_id,
    event_type: row.event_type,
    idempotency_key: row.idempotency_key,
    status: row.status,
    attempt_number: row.attempt_number,
    response_status: row.response_status,
    response_excerpt: row.response_excerpt,
    signed_body: row.signed_body,
    signature_header: row.signature_header,
    latency_ms: row.latency_ms,
    last_error: row.last_error,
    replay_of_id: row.replay_of_id,
    next_attempt_at: asIso(row.next_attempt_at),
    created_at: asIso(row.created_at),
    delivered_at: row.delivered_at === null ? null : asIso(row.delivered_at),
  };
}

const SUBSCRIPTION_COLUMNS = `id, app_id, workspace_id, event_type, target_url,
  signing_secret_hash, signing_secret_prefix, active, created_by, created_at`;

const DELIVERY_COLUMNS = `d.id, d.subscription_id, d.event_id, d.event_type, d.idempotency_key,
  d.status, d.attempt_number, d.response_status, d.response_excerpt, d.latency_ms,
  d.signed_body, d.signature_header,
  d.last_error, d.replay_of_id, d.next_attempt_at, d.created_at, d.delivered_at`;

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions
// ─────────────────────────────────────────────────────────────────────────────

function generateSigningSecret(): { raw: string; hash: string; prefix: string } {
  const raw = `${SIGNING_SECRET_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
  return {
    raw,
    hash: deriveSigningKey(raw),
    // The first 8 characters of the RANDOM BODY. The literal first 8 of the
    // string are `ship_whs` for every subscription ever issued — a prefix that
    // identifies nothing is not a prefix.
    prefix: raw.slice(SIGNING_SECRET_PREFIX.length, SIGNING_SECRET_PREFIX.length + 8),
  };
}

/**
 * Reject anything that is not an absolute http(s) URL.
 *
 * This is the cheap half of SSRF defense. The expensive half — refusing link-
 * local and private ranges after DNS resolution — belongs at delivery time
 * (DNS answers change between registration and delivery, so a check here is
 * decoration), and is noted as a known gap rather than pretended away.
 */
function normalizeTargetUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WebhookServiceError('invalid_target_url', 'target_url must be an absolute URL', {
      target_url: raw,
    });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new WebhookServiceError('invalid_target_url', 'target_url must use http or https', {
      target_url: raw,
    });
  }
  return parsed.toString();
}

export interface CreateSubscriptionInput {
  appId: string;
  workspaceId: string;
  eventType: string;
  targetUrl: string;
  createdBy?: string | null;
  db?: Queryable;
}

export interface CreateSubscriptionResult {
  subscription: SubscriptionView;
  /** Returned exactly once. Only `sha256(raw)` is persisted. */
  rawSigningSecret: string;
}

export async function createSubscription(
  input: CreateSubscriptionInput
): Promise<CreateSubscriptionResult> {
  const db = input.db ?? pool;
  try {
    assertKnownEventType(input.eventType);
  } catch (err) {
    throw new WebhookServiceError('unknown_event_type', (err as Error).message, {
      event_type: input.eventType,
      known_event_types: EVENT_TYPES,
    });
  }
  const targetUrl = normalizeTargetUrl(input.targetUrl);
  const secret = generateSigningSecret();

  try {
    const result = await db.query<SubscriptionRow>(
      `INSERT INTO webhook_subscriptions
         (app_id, workspace_id, event_type, target_url, signing_secret_hash,
          signing_secret_prefix, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [
        input.appId,
        input.workspaceId,
        input.eventType,
        targetUrl,
        secret.hash,
        secret.prefix,
        input.createdBy ?? null,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error('createSubscription: insert returned no row');
    return { subscription: toSubscriptionView(row), rawSigningSecret: secret.raw };
  } catch (err) {
    // UNIQUE(app_id, event_type, target_url). Registering the same triple
    // twice is a client bug that would otherwise silently double every
    // delivery, so it is a hard error rather than an upsert.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      throw new WebhookServiceError(
        'duplicate_subscription',
        'A subscription for this event type and target URL already exists',
        { event_type: input.eventType, target_url: targetUrl }
      );
    }
    throw err;
  }
}

export async function listSubscriptions(
  opts: { appId: string; eventType?: ShipEventType; db?: Queryable }
): Promise<SubscriptionView[]> {
  const db = opts.db ?? pool;
  const params: unknown[] = [opts.appId];
  let clause = '';
  if (opts.eventType) {
    params.push(opts.eventType);
    clause = ` AND event_type = $${params.length}`;
  }
  const result = await db.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS}
       FROM webhook_subscriptions
      WHERE app_id = $1${clause}
      ORDER BY created_at DESC, id DESC`,
    params
  );
  return result.rows.map(toSubscriptionView);
}

export async function getSubscription(
  opts: { appId: string; id: string; db?: Queryable }
): Promise<SubscriptionView | null> {
  const db = opts.db ?? pool;
  const result = await db.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions WHERE id = $1 AND app_id = $2`,
    [opts.id, opts.appId]
  );
  const row = result.rows[0];
  return row ? toSubscriptionView(row) : null;
}

/**
 * Delete a subscription. `app_id` is in the WHERE clause, not checked first:
 * a read-then-delete would need a reason for the two statements to agree, and
 * this way another app's id simply matches nothing.
 */
export async function deleteSubscription(
  opts: { appId: string; id: string; db?: Queryable }
): Promise<boolean> {
  const db = opts.db ?? pool;
  const result = await db.query<{ id: string }>(
    `DELETE FROM webhook_subscriptions WHERE id = $1 AND app_id = $2 RETURNING id`,
    [opts.id, opts.appId]
  );
  return result.rows.length > 0;
}

/** Used by the 410-Gone path in the deliverer, and by the portal's toggle. */
export async function setSubscriptionActive(
  opts: { id: string; active: boolean; db?: Queryable }
): Promise<boolean> {
  const db = opts.db ?? pool;
  const result = await db.query<{ id: string }>(
    `UPDATE webhook_subscriptions SET active = $2 WHERE id = $1 RETURNING id`,
    [opts.id, opts.active]
  );
  return result.rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery log
// ─────────────────────────────────────────────────────────────────────────────

export interface ListDeliveriesInput {
  appId: string;
  subscriptionId?: string;
  status?: string;
  cursor?: string;
  limit?: number;
  db?: Queryable;
}

/**
 * The per-app delivery log, keyset-paginated on (created_at, id) — the same
 * immutable pair every other v1 list uses, for the same reason: a delivery's
 * `updated_at` changes on every retry, so sorting by it would let a row that
 * has not been returned yet jump above the cursor and never be seen.
 */
export async function listDeliveries(input: ListDeliveriesInput): Promise<Page<DeliveryView>> {
  const db = input.db ?? pool;
  const pageSize = clampPageSize(input.limit);

  const where: string[] = ['s.app_id = $1'];
  const params: unknown[] = [input.appId];
  const push = (sql: string, value: unknown): void => {
    params.push(value);
    where.push(sql.replace('$?', `$${params.length}`));
  };

  if (input.subscriptionId) push('d.subscription_id = $?', input.subscriptionId);
  if (input.status) {
    if (!(DELIVERY_STATUSES as readonly string[]).includes(input.status)) {
      throw new WebhookServiceError('not_found', `Unknown delivery status: '${input.status}'`, {
        status: input.status,
        known_statuses: DELIVERY_STATUSES,
      });
    }
    push('d.status = $?', input.status);
  }

  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    if (!cursor) {
      throw new WebhookServiceError('not_found', 'Invalid cursor', {
        cursor: 'not a cursor issued by this API',
      });
    }
    const clause = keysetClause(cursor, {
      tsCol: 'd.created_at',
      idCol: 'd.id',
      paramOffset: params.length + 1,
    });
    where.push(clause.sql);
    params.push(...clause.params);
  }

  params.push(pageSize + 1);
  const result = await db.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS}
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.subscription_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${params.length}`,
    params
  );

  return buildPage(result.rows.map(toDeliveryView), pageSize, (d) => ({
    ts: d.created_at,
    id: d.id,
  }));
}

export async function getDelivery(
  opts: { appId: string; id: string; db?: Queryable }
): Promise<DeliveryView | null> {
  const db = opts.db ?? pool;
  const result = await db.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS}
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.subscription_id
      WHERE d.id = $1 AND s.app_id = $2`,
    [opts.id, opts.appId]
  );
  const row = result.rows[0];
  return row ? toDeliveryView(row) : null;
}

/**
 * Re-enqueue a delivery as a NEW row.
 *
 * The original is never mutated — a delivery log you can rewrite is not a log,
 * and "what actually happened on attempt 4 last Tuesday" has to stay
 * answerable after somebody clicks replay.
 *
 * INSERT ... SELECT is the important part: `idempotency_key` is copied from
 * the source row inside the same statement that reads it, so there is no code
 * path on which the replay could mint a fresh key. `replay_of_id` points at
 * the row that was replayed, so replays of replays form a walkable chain.
 */
export async function replayDelivery(
  opts: { id: string; appId?: string; db?: Queryable }
): Promise<DeliveryView> {
  const db = opts.db ?? pool;
  const result = await db.query<DeliveryRow>(
    `INSERT INTO webhook_deliveries
       (subscription_id, event_id, event_type, payload, idempotency_key, replay_of_id,
        status, attempt_number, next_attempt_at)
     SELECT src.subscription_id, src.event_id, src.event_type, src.payload,
            src.idempotency_key, src.id, 'pending', 0, now()
       FROM webhook_deliveries src
       JOIN webhook_subscriptions s ON s.id = src.subscription_id
      WHERE src.id = $1
        AND ($2::uuid IS NULL OR s.app_id = $2::uuid)
     RETURNING id, subscription_id, event_id, event_type, idempotency_key, status,
               attempt_number, response_status, response_excerpt, latency_ms,
               last_error, replay_of_id, next_attempt_at, created_at, delivered_at,
               signed_body, signature_header`,
    [opts.id, opts.appId ?? null]
  );
  const row = result.rows[0];
  // Same 404 whether the delivery does not exist or belongs to another app —
  // an existence oracle across tenants is an information leak.
  if (!row) throw new WebhookServiceError('not_found', 'Delivery not found');
  return toDeliveryView(row);
}
