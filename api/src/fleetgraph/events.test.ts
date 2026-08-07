/**
 * FleetBus timing contract — the piece the timed grading test rides on.
 * Fake timers only; no DB, no graph.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBOUNCE_MS, FleetBus, GRACE_RECHECK_MS } from './events.js';
import type { FleetTrigger } from './types.js';

type EventTrigger = Extract<FleetTrigger, { kind: 'event' }>;

const evt = (overrides: Partial<EventTrigger> = {}): EventTrigger => ({
  kind: 'event',
  workspaceId: 'ws-1',
  projectId: null,
  documentId: 'doc-1',
  eventType: 'created',
  ...overrides,
});

describe('FleetBus grace-expiry recheck', () => {
  let bus: FleetBus;
  let runs: EventTrigger[];

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new FleetBus();
    runs = [];
    bus.onRun((t) => runs.push(t));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('recheck window covers the orphan grace window with margin', () => {
    // If someone shrinks the grace window below the recheck the fast path
    // silently dies — this is the guard.
    expect(GRACE_RECHECK_MS).toBeGreaterThan(90_000);
  });

  it('one event → debounce run, then one grace-recheck run', () => {
    bus.emitShipEvent(evt());

    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.eventType).toBe('created');

    vi.advanceTimersByTime(GRACE_RECHECK_MS - DEBOUNCE_MS);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.eventType).toBe('grace_recheck');
  });

  it('a burst of edits re-arms both timers — one debounce run, one recheck, both from the last event', () => {
    bus.emitShipEvent(evt({ documentId: 'doc-1' }));
    vi.advanceTimersByTime(10_000);
    bus.emitShipEvent(evt({ documentId: 'doc-2', eventType: 'changed' }));

    // Debounce counts from the LAST event: nothing at first deadline.
    vi.advanceTimersByTime(DEBOUNCE_MS - 10_000);
    expect(runs).toHaveLength(0);
    vi.advanceTimersByTime(10_000);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.documentId).toBe('doc-2');

    // Recheck also counts from the last event — mirrors updated_at resetting
    // the grace window. Exactly one recheck, not one per event.
    vi.advanceTimersByTime(GRACE_RECHECK_MS);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ documentId: 'doc-2', eventType: 'grace_recheck' });
  });

  it('workspaces re-arm independently', () => {
    bus.emitShipEvent(evt({ workspaceId: 'ws-1' }));
    vi.advanceTimersByTime(GRACE_RECHECK_MS - 1_000);
    bus.emitShipEvent(evt({ workspaceId: 'ws-2' }));

    vi.advanceTimersByTime(1_000);
    // ws-1 recheck fires on schedule despite ws-2 traffic.
    expect(runs.filter((r) => r.eventType === 'grace_recheck')).toHaveLength(1);
    expect(runs.find((r) => r.eventType === 'grace_recheck')?.workspaceId).toBe('ws-1');
  });

  it('setDebounce shrinks both windows for E2E harnesses', () => {
    bus.setDebounce(50, 120);
    bus.emitShipEvent(evt());
    vi.advanceTimersByTime(50);
    expect(runs).toHaveLength(1);
    vi.advanceTimersByTime(70);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.eventType).toBe('grace_recheck');
  });
});
