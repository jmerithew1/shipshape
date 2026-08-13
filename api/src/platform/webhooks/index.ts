/**
 * Webhook subsystem entry point.
 *
 * One import for server startup and one barrel for everything else, so the
 * chokepoints in the domain code (`api/src/routes/issues.ts`,
 * `api/src/utils/document-crud.ts`) reach for a single module and never learn
 * the internal file layout.
 */
export * from './events.js';
export * from './bus.js';
export * from './signature.js';
export * from './deliverer.js';
export * from './service.js';

import { pool } from '../../db/client.js';
import {
  requeueStuckDeliveries,
  startDeliveryPoller,
  type PollerHandle,
} from './deliverer.js';
import { webhooksEnabled } from './bus.js';

let handle: PollerHandle | null = null;
let reaper: ReturnType<typeof setInterval> | null = null;

/**
 * Start the outbox poller. Called once from server startup.
 *
 * A no-op when WEBHOOKS_ENABLED=false — the kill switch stops delivery as well
 * as publication, so switching it off during an incident is a complete stop
 * rather than a queue that keeps draining.
 *
 * Requeuing rows left in 'delivering' by a process that died mid-attempt runs
 * BOTH at boot and periodically.
 *
 * Boot alone was silent permanent data loss, and the reason is worth keeping:
 * the sweep only matches rows older than a staleness threshold (so it can never
 * steal a row from a live attempt), but a deploy kills the process seconds
 * after those rows were claimed. The replacement process boots ~15s later, runs
 * the sweep once, matches nothing because the rows are far younger than the
 * threshold, and never sweeps again. Those rows sit in 'delivering' forever —
 * the claim query only selects 'pending' and 'failed', so they are never
 * delivered, never retried, and never dead-lettered. They do not even appear in
 * the DLQ, which is the one place an operator would look.
 *
 * A periodic reaper closes it: the rows become eligible once they age past the
 * threshold, and the very next sweep recovers them.
 */
export function initWebhooks(
  opts: { intervalMs?: number; reaperIntervalMs?: number } = {}
): PollerHandle | null {
  if (!webhooksEnabled()) {
    console.log('[webhooks] disabled (WEBHOOKS_ENABLED=false) — poller not started');
    return null;
  }
  if (handle) return handle;

  void requeueStuckDeliveries(pool).catch((err) =>
    console.error('[webhooks] startup requeue failed:', err)
  );

  // The periodic half. Interval is deliberately coarse — this is a safety net
  // for crashed processes, not a delivery path, and sweeping often would add
  // load during exactly the incident that produced the stuck rows.
  const reaperMs = opts.reaperIntervalMs ?? 60_000;
  reaper = setInterval(() => {
    void requeueStuckDeliveries(pool).catch((err) =>
      console.error('[webhooks] periodic requeue failed:', err)
    );
  }, reaperMs);
  if (typeof reaper.unref === 'function') reaper.unref();

  handle = startDeliveryPoller({
    now: () => Date.now(),
    fetch: globalThis.fetch,
    db: pool,
    intervalMs: opts.intervalMs ?? 1_000,
    // Pin the SSRF guard ON explicitly. The deliverer's default derives the
    // bypass from `NODE_ENV === 'test'`, which is convenient for suites but
    // means a stray NODE_ENV=test on a deployed worker would silently disable
    // the guard. Production wiring never leaves that to an ambient variable —
    // it passes false, so no environment value can turn the guard off here.
    allowPrivateTargets: false,
  });
  console.log('[webhooks] delivery poller started (SSRF guard enforced)');
  return handle;
}

export function stopWebhooks(): void {
  handle?.stop();
  handle = null;
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}
