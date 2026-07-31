/**
 * Gap 2 repro — one stray (un-awaited) promise rejection vs. the API process.
 *
 * Boots the real API entrypoint in-process, waits until /health answers, then
 * 3 s later fires an un-awaited Promise.reject — the exact failure mode of a
 * rejected promise nobody awaits inside a request handler or background task.
 * If the process is still alive 15 s after readiness, it exits 0 (repro over).
 *
 * Run from api/ so dependencies resolve:
 *   PORT=3790 pnpm -C api exec tsx ../docs/pr-evidence/week4-cat6/repro-unhandled-rejection.ts
 *
 * Pre-fix (before dd98511): Node's default handler terminates the process —
 * ERR_UNHANDLED_REJECTION, non-zero exit, /health stops answering.
 * Post-fix: 'UNHANDLED PROMISE REJECTION (continuing to serve)' is logged and
 * /health keeps answering until the clean shutdown. Drive with
 * repro-unhandled-rejection.sh, which probes /health from outside and records
 * the exit code.
 */
import '../../../api/src/index.ts';

const PORT = process.env.PORT ?? '3000';

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
  console.log('[repro] /health is answering — server is up');
  setTimeout(() => {
    console.log('[repro] firing an un-awaited Promise.reject now (t=ready+3s)');
    Promise.reject(new Error('repro: stray rejection from a request handler'));
  }, 3000);
  setTimeout(() => {
    console.log('[repro] still alive at t=ready+15s — shutting down cleanly (repro over)');
    process.exit(0);
  }, 15000);
});
