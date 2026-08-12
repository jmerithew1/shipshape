/**
 * IEventBus — the publish side of the webhook subsystem.
 *
 * THE OUTBOX IS THE QUEUE. Publishing does not call anybody's URL; it writes
 * `webhook_deliveries` rows inside the caller's transaction. That single
 * decision buys three properties that a fire-and-forget HTTP call cannot:
 *
 *   1. NO PHANTOM EVENTS. If the domain transaction rolls back, so does the
 *      delivery row. An HTTP call made during a transaction that later aborts
 *      has already told the world about a thing that never happened.
 *   2. NO LOST EVENTS. If the process dies one millisecond after COMMIT, the
 *      row is durable and the poller picks it up on the next boot.
 *   3. NO LATENCY TAX ON THE WRITE PATH. The user's request pays one INSERT,
 *      not N HTTP round trips to whatever slow endpoints are registered.
 *
 * The insert is set-based — ONE statement fans out to every matching
 * subscription — so a workspace with fifty subscribers costs the write path
 * the same as a workspace with one.
 *
 * ORDERING CONSTRAINT (do not "clean this up")
 * --------------------------------------------
 * `WEBHOOKS_ENABLED === 'false'` is checked BEFORE any query, exactly like
 * FLEETGRAPH_ENABLED in api/src/utils/document-crud.ts. Four internal route
 * suites mock `pool.query` with strict call sequences; a lookup issued here
 * would eat one of their mocked responses and fail tests in files this
 * subsystem has never heard of. src/test/setup.ts sets the flag to 'false'
 * for exactly that reason, and the webhook suites re-enable it explicitly.
 */
import { pool } from '../../db/client.js';
import {
  assertKnownEventType,
  idempotencyKeyFor,
  type ShipEvent,
} from './events.js';

/** Anything that can run parameterized SQL: the pool, or a client mid-transaction. */
export interface Queryable {
  query: typeof pool.query;
}

export interface IEventBus {
  /**
   * Record an event for delivery.
   *
   * @param client Optional transaction client. Pass the SAME client the
   *   domain write used and the delivery rows commit or roll back with it —
   *   that is the whole point of the outbox. Omit it and the rows are written
   *   on the pool, which is correct for writes that already committed.
   */
  publish(event: ShipEvent, client?: Queryable): Promise<void>;
}

/** True unless the kill switch is explicitly off. Read per call, never cached:
 *  tests flip the env var between cases, and a module-load snapshot would
 *  freeze whichever value happened to be set when the file was first imported. */
export function webhooksEnabled(): boolean {
  return process.env.WEBHOOKS_ENABLED !== 'false';
}

/**
 * The must-ship bus: matches active subscriptions for the event's type and
 * workspace, and inserts one pending delivery per match.
 */
export class OutboxEventBus implements IEventBus {
  constructor(private readonly db: Queryable = pool) {}

  async publish(event: ShipEvent, client?: Queryable): Promise<void> {
    // FIRST LINE. See the header — this must precede every query.
    if (!webhooksEnabled()) return;

    assertKnownEventType(event.type);

    const db = client ?? this.db;

    // INSERT ... SELECT is the fan-out: the subscription table decides how
    // many rows appear, and it happens in one round trip inside the caller's
    // transaction. attempt_number defaults to 0 and next_attempt_at to now(),
    // so the row is immediately due — the poller needs no separate enqueue.
    await db.query(
      `INSERT INTO webhook_deliveries
         (subscription_id, event_id, event_type, payload, idempotency_key)
       SELECT s.id, $1::uuid, $2::text, $3::jsonb, $4::text
         FROM webhook_subscriptions s
        WHERE s.active
          AND s.event_type = $2::text
          AND s.workspace_id = $5::uuid`,
      [event.id, event.type, JSON.stringify(event), idempotencyKeyFor(event), event.workspace_id]
    );
  }
}

/**
 * The bus used when webhooks are switched off. Not a stub for tests — it is
 * the production behavior of the kill switch, and it exists so callers never
 * branch on the flag themselves.
 */
export class NoopEventBus implements IEventBus {
  /** Test seam: proves a chokepoint reached the bus even with delivery off. */
  readonly published: ShipEvent[] = [];

  async publish(event: ShipEvent): Promise<void> {
    this.published.push(event);
  }
}

let overrideBus: IEventBus | null = null;

/**
 * The bus the domain chokepoints publish through.
 *
 * Resolved per call rather than at module load so the kill switch is live:
 * flipping WEBHOOKS_ENABLED changes behavior without a restart, and a test
 * that enables webhooks for one file does not leak into the next.
 */
export function getEventBus(): IEventBus {
  if (overrideBus) return overrideBus;
  return webhooksEnabled() ? new OutboxEventBus() : new NoopEventBus();
}

/** Test/wiring seam. Pass null to restore the default resolution. */
export function setEventBus(bus: IEventBus | null): void {
  overrideBus = bus;
}

/**
 * Fire-and-forget publish for the domain chokepoints.
 *
 * Webhook delivery must NEVER fail a user's write. This wrapper is what the
 * chokepoints call: it checks the kill switch before touching anything, and
 * it swallows publish failures after logging them — the same contract the
 * FleetGraph hook already established at these exact call sites.
 *
 * Use `getEventBus().publish(event, client)` directly (and await it) when the
 * publish belongs inside the caller's transaction; use this when the write
 * has already committed and the event is best-effort.
 */
export function publishEventSafely(event: ShipEvent): void {
  if (!webhooksEnabled()) return;
  void (async () => {
    try {
      await getEventBus().publish(event);
    } catch (err) {
      console.error(`[webhooks] publish failed for ${event.type} (${event.id}):`, err);
    }
  })();
}
