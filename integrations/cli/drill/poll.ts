/**
 * Bounded polling, and the reason there is not a single `sleep(3000)` in this
 * drill.
 *
 * A fixed sleep encodes an assumption about someone else's latency. It is
 * simultaneously too slow (the event was there in 200 ms) and too fragile (CI
 * was cold and took 4 s), which is exactly the shape of a test that passes on
 * a laptop and flakes in CI. The graded targets here are <60 s and 0% flake
 * over 20 runs, so every wait in this drill is "poll on a tight interval until
 * a predicate holds, or fail loudly at a deadline".
 */
export interface PollOptions<T> {
  /** Returns the value when the condition holds, or null to keep waiting. */
  attempt: () => Promise<T | null>;
  timeoutMs: number;
  intervalMs: number;
  /** Used in the timeout message so a failure says what was being waited for. */
  describe: string;
  signal?: AbortSignal;
}

export class PollTimeoutError extends Error {
  constructor(describe: string, timeoutMs: number, attempts: number) {
    super(`Timed out after ${timeoutMs} ms waiting for ${describe} (${attempts} attempts)`);
    this.name = 'PollTimeoutError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function pollUntil<T>(options: PollOptions<T>): Promise<T> {
  const deadline = performance.now() + options.timeoutMs;
  let attempts = 0;

  for (;;) {
    if (options.signal?.aborted === true) {
      throw new PollTimeoutError(`${options.describe} (aborted)`, options.timeoutMs, attempts);
    }
    attempts += 1;
    const result = await options.attempt();
    if (result !== null) return result;

    // Check the deadline AFTER an attempt, so a timeout of 0 still tries once
    // and a slow single attempt is never counted as "never tried".
    if (performance.now() >= deadline) {
      throw new PollTimeoutError(options.describe, options.timeoutMs, attempts);
    }
    await sleep(options.intervalMs);
  }
}
