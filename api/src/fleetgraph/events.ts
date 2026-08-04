/**
 * In-process event bus — the "webhook" that collapsed into an emit
 * (FLEETGRAPH.md §Trigger Model). Hooked from the create routes and the
 * logDocumentChange chokepoint; debounced per workspace so a burst of edits
 * triggers one run, not thirty.
 */
import { EventEmitter } from 'node:events';
import type { FleetTrigger } from './types.js';

export const DEBOUNCE_MS = 30_000;

type EventTrigger = Extract<FleetTrigger, { kind: 'event' }>;

class FleetBus extends EventEmitter {
  private pending = new Map<string, { timer: NodeJS.Timeout; latest: EventTrigger }>();
  private debounceMs = DEBOUNCE_MS;

  /** Tests shrink the debounce window; production leaves it alone. */
  setDebounce(ms: number): void {
    this.debounceMs = ms;
  }

  emitShipEvent(trigger: EventTrigger): void {
    const key = trigger.workspaceId;
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.emit('run', this.pending.get(key)?.latest ?? trigger);
    }, this.debounceMs);
    // Don't keep the process alive just for a pending debounce.
    timer.unref();
    this.pending.set(key, { timer, latest: trigger });
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
