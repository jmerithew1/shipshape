/**
 * Gap 2 capture harness — repro-unhandled-rejection.ts with a controllable
 * fuse, so a browser session has time to sign in before the rejection fires.
 *
 * Boots the real API entrypoint in-process, waits for /health, then fires an
 * un-awaited Promise.reject after REJECT_AFTER_MS (default 30 s). Stays alive
 * STAY_ALIVE_MS after readiness (default 60 s), then exits 0 cleanly.
 *
 *   Pre-fix (before dd98511): Node's default handler terminates the process
 *   at the rejection — every signed-in user's next request dies with it.
 *   Post-fix: the rejection is logged and the API keeps serving.
 *
 * Run from repo root (dependencies resolve via api/):
 *   PORT=3791 REJECT_AFTER_MS=30000 pnpm -C api exec tsx ../docs/pr-evidence/week4-cat6/rejection-harness.ts
 */
import '../../../api/src/index.ts';

const PORT = process.env.PORT ?? '3000';
const REJECT_AFTER_MS = Number(process.env.REJECT_AFTER_MS ?? 30000);
const STAY_ALIVE_MS = Number(process.env.STAY_ALIVE_MS ?? 60000);

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server never became healthy');
}

waitForHealth().then(() => {
  console.log('[harness] /health is answering — server is up');
  setTimeout(() => {
    console.log(`[harness] firing an un-awaited Promise.reject now (t=ready+${REJECT_AFTER_MS / 1000}s)`);
    Promise.reject(new Error('repro: stray rejection from a request handler'));
  }, REJECT_AFTER_MS);
  setTimeout(() => {
    console.log(`[harness] still alive at t=ready+${STAY_ALIVE_MS / 1000}s — shutting down cleanly (capture over)`);
    process.exit(0);
  }, STAY_ALIVE_MS);
});
