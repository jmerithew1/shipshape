/**
 * Stage timing for the drill.
 *
 * `performance.now()` rather than `Date.now()` because the number being
 * measured is an interval, and a monotonic clock is the only one that cannot
 * be moved by NTP mid-run. A drill whose pass/fail depends on wall-clock
 * corrections is a flaky drill, and the graded target is 0% flake.
 */
export interface Stage {
  name: string;
  ms: number;
  note?: string;
}

export class Stopwatch {
  private readonly stages: Stage[] = [];
  private readonly startedAt = performance.now();

  /** Time an async step and record it under `name`. */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const from = performance.now();
    try {
      return await fn();
    } finally {
      this.stages.push({ name, ms: Math.round(performance.now() - from) });
    }
  }

  /** Record a stage measured somewhere else (e.g. `pnpm install` in CI). */
  record(name: string, ms: number, note?: string): void {
    this.stages.push(note === undefined ? { name, ms } : { name, ms, note });
  }

  /** Attach an explanatory note to the most recently completed stage. */
  annotate(name: string, note: string): void {
    for (let i = this.stages.length - 1; i >= 0; i--) {
      const stage = this.stages[i];
      if (stage !== undefined && stage.name === name) {
        stage.note = note;
        return;
      }
    }
  }

  list(): readonly Stage[] {
    return this.stages;
  }

  /** Sum of recorded stages — not wall time, so an externally-measured
   *  install stage counts even though it happened before this process. */
  total(): number {
    return this.stages.reduce((sum, stage) => sum + stage.ms, 0);
  }

  /** Wall time inside this process, for the sanity check in the report. */
  elapsed(): number {
    return Math.round(performance.now() - this.startedAt);
  }
}

/** `  1420 ms` — right-aligned so the table scans vertically. */
function ms(value: number): string {
  return `${String(value).padStart(6)} ms`;
}

export function formatTimingTable(
  stages: readonly Stage[],
  total: number,
  thresholdMs: number
): string {
  const width = Math.max(8, ...stages.map((s) => s.name.length));
  const lines = [`${'stage'.padEnd(width)}   elapsed`];
  lines.push('─'.repeat(width + 12));
  for (const stage of stages) {
    const note = stage.note === undefined ? '' : `   ${stage.note}`;
    lines.push(`${stage.name.padEnd(width)}  ${ms(stage.ms)}${note}`);
  }
  lines.push('─'.repeat(width + 12));
  const verdict = total <= thresholdMs ? 'PASS' : 'FAIL';
  lines.push(`${'total'.padEnd(width)}  ${ms(total)}   ${verdict} (threshold ${thresholdMs} ms)`);
  return lines.join('\n');
}
