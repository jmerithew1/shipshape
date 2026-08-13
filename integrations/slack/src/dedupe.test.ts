import { describe, expect, it } from 'vitest';
import { IdempotencyStore } from './dedupe.js';

describe('IdempotencyStore', () => {
  it('claims a key once', () => {
    const store = new IdempotencyStore();
    expect(store.claim('evt_a')).toBe(true);
    expect(store.claim('evt_a')).toBe(false);
  });

  it('releases a key so a retry can claim it again', () => {
    const store = new IdempotencyStore();
    store.claim('evt_a');
    store.release('evt_a');
    expect(store.claim('evt_a')).toBe(true);
  });

  it('never blocks when disabled — the control arm for the dedupe test', () => {
    const store = new IdempotencyStore({ enabled: false });
    expect(store.claim('evt_a')).toBe(true);
    expect(store.claim('evt_a')).toBe(true);
  });

  it('evicts the oldest key past the bound instead of growing forever', () => {
    const store = new IdempotencyStore({ maxEntries: 3 });
    store.claim('a');
    store.claim('b');
    store.claim('c');
    store.claim('d');

    expect(store.size).toBe(3);
    expect(store.has('a')).toBe(false); // evicted
    expect(store.has('d')).toBe(true);
    // The consequence, stated plainly: a key evicted under pressure can be
    // claimed again, i.e. the bound trades a duplicate post for a memory cap.
    expect(store.claim('a')).toBe(true);
  });

  it('keeps at least one entry even with a nonsensical bound', () => {
    const store = new IdempotencyStore({ maxEntries: 0 });
    expect(store.claim('a')).toBe(true);
    expect(store.claim('a')).toBe(false);
  });
});
