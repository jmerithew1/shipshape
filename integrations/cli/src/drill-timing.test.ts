/**
 * The drill's timing machinery. Lives here (rather than under drill/) because
 * this package runs one vitest suite over src/, and a stopwatch that silently
 * loses a stage would turn the TTFE budget into decoration.
 */
import { describe, expect, it } from 'vitest';
import { formatTimingTable, Stopwatch } from '../drill/timing.js';
import { pollUntil, PollTimeoutError } from '../drill/poll.js';
import { readConfig } from '../drill/ttfe.js';

describe('Stopwatch', () => {
  it('records stages in order and sums them', async () => {
    const watch = new Stopwatch();
    await watch.time('a', async () => 1);
    await watch.time('b', async () => 2);
    watch.record('external', 500, 'measured elsewhere');

    const names = watch.list().map((s) => s.name);
    expect(names).toEqual(['a', 'b', 'external']);
    expect(watch.total()).toBeGreaterThanOrEqual(500);
    expect(watch.list().at(-1)?.note).toBe('measured elsewhere');
  });

  it('still records a stage that threw — a failed stage has a duration too', async () => {
    const watch = new Stopwatch();
    await expect(
      watch.time('boom', async () => {
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');
    expect(watch.list().map((s) => s.name)).toEqual(['boom']);
  });

  it('annotates the named stage', async () => {
    const watch = new Stopwatch();
    await watch.time('subscribe', async () => 0);
    watch.annotate('subscribe', 'document.created → https://example.com');
    expect(watch.list()[0]?.note).toContain('document.created');
  });
});

describe('formatTimingTable', () => {
  const stages = [
    { name: 'install', ms: 120 },
    { name: 'login', ms: 400 },
    { name: 'receive', ms: 900, note: 'delivery log' },
  ];

  it('says PASS under the threshold and FAIL over it', () => {
    expect(formatTimingTable(stages, 1420, 60_000)).toContain('PASS');
    expect(formatTimingTable(stages, 61_000, 60_000)).toContain('FAIL');
  });

  it('shows every stage, the total, and the threshold it was judged against', () => {
    const table = formatTimingTable(stages, 1420, 60_000);
    for (const stage of stages) expect(table).toContain(stage.name);
    expect(table).toContain('1420 ms');
    expect(table).toContain('threshold 60000 ms');
    expect(table).toContain('delivery log');
  });
});

describe('pollUntil', () => {
  it('returns as soon as the predicate holds, without a fixed sleep', async () => {
    let calls = 0;
    const value = await pollUntil<string>({
      attempt: async () => (++calls >= 3 ? 'ready' : null),
      timeoutMs: 5000,
      intervalMs: 1,
      describe: 'a thing',
    });
    expect(value).toBe('ready');
    expect(calls).toBe(3);
  });

  it('always makes at least one attempt, even at a zero timeout', async () => {
    let calls = 0;
    await expect(
      pollUntil({
        attempt: async () => {
          calls += 1;
          return null;
        },
        timeoutMs: 0,
        intervalMs: 1,
        describe: 'never',
      })
    ).rejects.toBeInstanceOf(PollTimeoutError);
    expect(calls).toBe(1);
  });

  it('names what it was waiting for, so a CI timeout is diagnosable', async () => {
    await expect(
      pollUntil({
        attempt: async () => null,
        timeoutMs: 0,
        intervalMs: 1,
        describe: 'a document.created delivery',
      })
    ).rejects.toThrow('a document.created delivery');
  });
});

describe('drill configuration', () => {
  it('defaults the threshold to 60 000 ms — the graded budget', () => {
    expect(readConfig([], {}).thresholdMs).toBe(60_000);
  });

  it('lets a flag override the environment override the default', () => {
    expect(readConfig(['--threshold', '15000'], { SHIP_DRILL_THRESHOLD_MS: '30000' }).thresholdMs)
      .toBe(15_000);
    expect(readConfig([], { SHIP_DRILL_THRESHOLD_MS: '30000' }).thresholdMs).toBe(30_000);
  });

  it('accepts an externally measured install time, for a CI-timed pnpm install', () => {
    expect(readConfig([], { SHIP_DRILL_INSTALL_MS: '8200' }).externalInstallMs).toBe(8200);
    expect(readConfig([], {}).externalInstallMs).toBeUndefined();
  });

  it('is poll-mode unless --listen asks for a real inbound receiver', () => {
    expect(readConfig([], {}).listenPort).toBeUndefined();
    expect(readConfig(['--listen'], {}).listenPort).toBe(4242);
    expect(readConfig(['--listen', '9100'], {}).listenPort).toBe(9100);
  });
});
