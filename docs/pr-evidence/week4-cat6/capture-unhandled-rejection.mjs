/**
 * Gap 2 visual evidence — one stray promise rejection vs. every signed-in user.
 *
 * Drives the real app in Chromium while the real API (booted through
 * rejection-harness.ts) takes an un-awaited Promise.reject mid-session:
 * sign in, browse to /docs, then — at the moment the rejection fires in the
 * API process — reload the page a signed-in user is looking at.
 *
 *   Pre-fix (before dd98511): the API process dies; the reload gets
 *   net::ERR_CONNECTION_REFUSED — every user's session hits a dead server.
 *   Post-fix: 'UNHANDLED PROMISE REJECTION (continuing to serve)' is logged
 *   and the reload renders normally; /health answers before and after.
 *
 * Usage (repo root; docker compose postgres up on :5433; web/dist built):
 *   PHASE=after node docs/pr-evidence/week4-cat6/capture-unhandled-rejection.mjs
 * For PHASE=before, first: git show dd98511~1:api/src/index.ts > api/src/index.ts
 * then run with PHASE=before, then: git checkout -- api/src/index.ts
 */
import { chromium } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PHASE = process.env.PHASE ?? 'after';
const OUTDIR = 'docs/pr-evidence/week4-cat6';
const API_PORT = process.env.API_PORT ?? '3791';
const WEB_PORT = process.env.WEB_PORT ?? '4274';
const BASE = `http://localhost:${WEB_PORT}`;
const EMAIL = process.env.SHIP_EMAIL ?? 'dev@ship.local';
const PASSWORD = process.env.SHIP_PASSWORD ?? 'admin123';
const REJECT_AFTER_MS = 30000;

const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

const indexHash = execSync('git hash-object api/src/index.ts').toString().trim();
log(`=== ${new Date().toISOString()} — capture-unhandled-rejection PHASE=${PHASE} ===`);
log(`=== api/src/index.ts @ ${indexHash} (git hash-object; API runs it via tsx) ===`);
log('');

async function probeHealth(tag) {
  try {
    const res = await fetch(`http://localhost:${API_PORT}/health`, { signal: AbortSignal.timeout(3000) });
    log(`[probe] /health ${tag}: HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    log(`[probe] /health ${tag}: NO RESPONSE (${e.cause?.code ?? e.name})`);
    return false;
  }
}

// --- boot API (via harness) and web preview ----------------------------------
log(`[step] booting API on :${API_PORT} through rejection-harness.ts (rejection at ready+${REJECT_AFTER_MS / 1000}s)`);
let rejectionFiredAt = 0;
let apiExit = null;
const api = spawn('pnpm', ['-C', 'api', 'exec', 'tsx', '../docs/pr-evidence/week4-cat6/rejection-harness.ts'], {
  env: { ...process.env, PORT: API_PORT, REJECT_AFTER_MS: String(REJECT_AFTER_MS), STAY_ALIVE_MS: '90000' },
  shell: true,
});
api.stdout.on('data', (d) => {
  for (const l of d.toString().split(/\r?\n/)) {
    if (!l.trim()) continue;
    log(`[api] ${l}`);
    if (l.includes('firing an un-awaited Promise.reject')) rejectionFiredAt = Date.now();
  }
});
api.stderr.on('data', (d) => { for (const l of d.toString().split(/\r?\n/)) if (l.trim()) log(`[api!] ${l}`); });
api.on('close', (code) => { apiExit = code; log(`[api] process exited with code ${code}`); });

log(`[step] starting vite preview on :${WEB_PORT} (proxying /api -> :${API_PORT})`);
const web = spawn('pnpm', ['-C', 'web', 'exec', 'vite', 'preview'], {
  env: { ...process.env, API_PORT, VITE_PORT: WEB_PORT },
  shell: true,
});
web.stdout.on('data', () => {});
web.stderr.on('data', () => {});

// wait for both to answer
for (let i = 0; i < 60; i++) {
  try {
    const ok = (await fetch(`http://localhost:${API_PORT}/health`)).ok
      && (await fetch(BASE)).ok;
    if (ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 1000));
}
const readyAt = Date.now();
await probeHealth('at start');

// --- browser session ----------------------------------------------------------
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: path.join(OUTDIR, 'video-tmp'), size: { width: 1280, height: 800 } },
});
const page = await context.newPage();

log(`[step] goto ${BASE}/login and sign in as ${EMAIL}`);
await page.goto(`${BASE}/login`);
await page.getByPlaceholder('Email address').fill(EMAIL);
await page.getByPlaceholder('Password').fill(PASSWORD);
await page.getByRole('button', { name: /sign in|log in/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
await page.goto(`${BASE}/docs`);
await page.getByRole('button', { name: 'New Document' }).waitFor({ timeout: 20000 });
log(`[step] signed in; user is working at ${page.url()}`);
await page.screenshot({ path: path.join(OUTDIR, `rejection-${PHASE}-01-before.png`) });

// --- wait for the rejection to fire in the API process ------------------------
const untilRejection = REJECT_AFTER_MS - (Date.now() - readyAt) + 3000;
log(`[step] waiting ~${Math.max(0, Math.round(untilRejection / 1000))}s for the in-process rejection to fire`);
await new Promise((r) => setTimeout(r, Math.max(0, untilRejection)));
if (rejectionFiredAt) log(`[step] rejection fired in the API process at ${new Date(rejectionFiredAt).toISOString()}`);
await new Promise((r) => setTimeout(r, 2000));

// --- the user's next action ----------------------------------------------------
log('[step] the signed-in user reloads the page they were on');
let reloadError = null;
try {
  await page.reload({ timeout: 15000, waitUntil: 'domcontentloaded' });
} catch (e) {
  reloadError = e.message.split('\n')[0];
}
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(OUTDIR, `rejection-${PHASE}-02-after.png`) });
const healthAfter = await probeHealth('after the rejection');

log('');
log(`[result] reload outcome: ${reloadError ? `FAILED — ${reloadError}` : `rendered normally at ${page.url()}`}`);
log(`[result] API process exit so far: ${apiExit === null ? 'still running' : `code ${apiExit}`}`);
if (!healthAfter || reloadError) {
  log('[result] VERDICT: one stray rejection killed the API for every signed-in user (pre-fix behavior)');
} else {
  log('[result] VERDICT: rejection logged, API kept serving, the user never noticed (post-fix behavior)');
}

await context.close();
const video = await page.video()?.path();
if (video) {
  const dest = path.join(OUTDIR, `rejection-${PHASE}.webm`);
  fs.copyFileSync(video, dest);
  fs.rmSync(path.join(OUTDIR, 'video-tmp'), { recursive: true, force: true });
  log(`[artifact] recording: ${dest}`);
}
await browser.close();

api.kill(); web.kill();
try { execSync(process.platform === 'win32' ? `taskkill /F /T /PID ${api.pid} 2>nul & taskkill /F /T /PID ${web.pid} 2>nul` : `kill -9 ${api.pid} ${web.pid}`, { shell: true }); } catch { /* already gone */ }

fs.writeFileSync(path.join(OUTDIR, `rejection-${PHASE}-transcript.txt`), lines.join('\n') + '\n');
console.log(`transcript written to ${OUTDIR}/rejection-${PHASE}-transcript.txt`);
