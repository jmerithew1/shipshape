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

/**
 * Start the outbox poller. Called once from server startup.
 *
 * A no-op when WEBHOOKS_ENABLED=false — the kill switch stops delivery as well
 * as publication, so switching it off during an incident is a complete stop
 * rather than a queue that keeps draining.
 *
 * Startup also requeues rows left in 'delivering' by a process that died
 * mid-attempt. That sweep belongs at boot because boot is the moment we know
 * the previous process is gone; a row stuck in 'delivering' is invisible to
 * the claim query and would otherwise never be retried.
 */
export function initWebhooks(opts: { intervalMs?: number } = {}): PollerHandle | null {
  if (!webhooksEnabled()) {
    console.log('[webhooks] disabled (WEBHOOKS_ENABLED=false) — poller not started');
    return null;
  }
  if (handle) return handle;

  void requeueStuckDeliveries(pool).catch((err) =>
    console.error('[webhooks] startup requeue failed:', err)
  );

  handle = startDeliveryPoller({
    now: () => Date.now(),
    fetch: globalThis.fetch,
    db: pool,
    intervalMs: opts.intervalMs ?? 1_000,
  });
  console.log('[webhooks] delivery poller started');
  return handle;
}

export function stopWebhooks(): void {
  handle?.stop();
  handle = null;
}
