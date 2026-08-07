/**
 * In-process event bus — the "webhook" that collapsed into an emit
 * (FLEETGRAPH.md §Trigger Model). Hooked from the create routes and the
 * logDocumentChange chokepoint; debounced per workspace so a burst of edits
 * triggers one run, not thirty.
 *
 * Two timers per workspace, both re-armed on every event:
 *  - debounce (30 s): the fast run for detectors with no grace window.
 *  - grace recheck (ORPHAN_GRACE_SECONDS + 10 s): fires one run right after
 *    the orphan grace window can first be satisfied, so detection of a
 *    fresh orphan never waits on sweep alignment. Re-arming tracks the
 *    grace window itself — every edit bumps updated_at, so the recheck
 *    lands ~10 s after grace genuinely expires. The sweep stays as the
 *    backstop for events lost to a restart.
 */
import { EventEmitter } from 'node:events';
import { ORPHAN_GRACE_SECONDS } from './detectors.js';
import type { FleetTrigger } from './types.js';

export const DEBOUNCE_MS = 30_000;
export const GRACE_RECHECK_MS = (ORPHAN_GRACE_SECONDS + 10) * 1000;

type EventTrigger = Extract<FleetTrigger, { kind: 'event' }>;

export class FleetBus extends EventEmitter {
  private pending = new Map<string, NodeJS.Timeout>();
  private rechecks = new Map<string, NodeJS.Timeout>();
  private debounceMs = DEBOUNCE_MS;
  private recheckMs = GRACE_RECHECK_MS;

  /** Tests shrink the windows; production leaves them alone. */
  setDebounce(ms: number, recheckMs?: number): void {
    this.debounceMs = ms;
    if (recheckMs !== undefined) this.recheckMs = recheckMs;
  }

  emitShipEvent(trigger: EventTrigger): void {
    const key = trigger.workspaceId;

    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.emit('run', trigger);
    }, this.debounceMs);
    // Don't keep the process alive just for a pending timer.
    timer.unref();
    this.pending.set(key, timer);

    const existingRecheck = this.rechecks.get(key);
    if (existingRecheck) clearTimeout(existingRecheck);
    const recheck = setTimeout(() => {
      this.rechecks.delete(key);
      this.emit('run', { ...trigger, eventType: 'grace_recheck' });
    }, this.recheckMs);
    recheck.unref();
    this.rechecks.set(key, recheck);
  }

  onRun(handler: (trigger: EventTrigger) => void): void {
    this.on('run', handler);
  }
}

export const fleetBus = new FleetBus();

/**
 * Fire-and-forget hook for mutating routes. Deliberately swallows nothing:
 * emitting is synchronous bookkeeping; the graph run happens after the
 * debounce window on its own timer, never on the request path.
 */
export function notifyShipEvent(params: {
  workspaceId: string;
  documentId: string;
  projectId?: string | null;
  eventType: 'created' | 'changed';
}): void {
  if (process.env.FLEETGRAPH_ENABLED === 'false') return;
  fleetBus.emitShipEvent({
    kind: 'event',
    workspaceId: params.workspaceId,
    documentId: params.documentId,
    projectId: params.projectId ?? null,
    eventType: params.eventType,
  });
}
