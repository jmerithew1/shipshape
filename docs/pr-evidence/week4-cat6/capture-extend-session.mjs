/**
 * Gap 3 visual evidence — transient extend-session failure during "Stay Logged In".
 *
 * Drives the real app in Chromium: log in, fast-forward the mocked clock to the
 * 14-minute inactivity warning, drop the network for /api/auth/extend-session
 * (route.abort — a wifi blip), and press Enter on the focused "Stay Logged In"
 * button. Captures screenshots, a webm recording, and a step transcript.
 *
 *   Pre-fix (before 22acc2f): the catch treats the network error as session
 *   death -> hard redirect to /login?expired=true — the user-facing data loss.
 *   Post-fix: console warning, modal dismissed, user stays where they were.
 *
 * Usage (repo root; API on :3789 serving ship_dev, vite preview on :4273):
 *   PHASE=after node docs/pr-evidence/week4-cat6/capture-extend-session.mjs
 * For PHASE=before, first: git show 22acc2f~1:web/src/hooks/useSessionTimeout.ts \
 *   > web/src/hooks/useSessionTimeout.ts && pnpm -C web build   (then restore).
 */
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PHASE = process.env.PHASE ?? 'after';
const BASE = process.env.BASE_URL ?? 'http://localhost:4273';
const OUTDIR = 'docs/pr-evidence/week4-cat6';
const EMAIL = process.env.SHIP_EMAIL ?? 'dev@ship.local';
const PASSWORD = process.env.SHIP_PASSWORD ?? 'admin123';

const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

const hookHash = execSync('git hash-object web/src/hooks/useSessionTimeout.ts').toString().trim();
log(`=== ${new Date().toISOString()} — capture-extend-session PHASE=${PHASE} ===`);
log(`=== web/src/hooks/useSessionTimeout.ts @ ${hookHash} (git hash-object; web/dist built from it) ===`);
log('');

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: path.join(OUTDIR, 'video-tmp'), size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'warning' || msg.type() === 'error') {
    log(`[browser console.${msg.type()}] ${msg.text()}`);
  }
});

// Fake the clock before the app loads so the hook's 13-minute warning timer is
// controllable; then fast-forward instead of waiting 14 real minutes.
await page.clock.install();

log(`[step] goto ${BASE}/login and sign in as ${EMAIL}`);
await page.goto(`${BASE}/login`);
await page.getByPlaceholder('Email address').fill(EMAIL);
await page.getByPlaceholder('Password').fill(PASSWORD);
await page.getByRole('button', { name: /sign in|log in/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });

// Go somewhere concrete — the docs list — and wait for the app shell to mount,
// same pattern as e2e/session-timeout.spec.ts.
await page.goto(`${BASE}/docs`);
await page.getByRole('button', { name: 'New Document' }).waitFor({ timeout: 15000 });
const placeUrl = page.url();
log(`[step] signed in; user's place in the app: ${placeUrl}`);

log('[step] fast-forwarding the clock 14 minutes to trigger the inactivity warning');
await page.clock.fastForward('14:10');
const dialog = page.getByRole('alertdialog');
await dialog.waitFor({ state: 'visible', timeout: 10000 });
log('[step] inactivity warning visible ("Your session is about to expire")');
await page.screenshot({ path: path.join(OUTDIR, `extend-session-${PHASE}-01-warning.png`) });

log('[step] dropping the network for all /api/** requests (route.abort = wifi blip)');
await context.route('**/api/**', (route) => route.abort('connectionfailed'));

log('[step] pressing Enter on the focused "Stay Logged In" button');
// Register the redirect watcher before the keypress: the pre-fix hard redirect
// to /login?expired=true fires within milliseconds of the failed request.
const redirect = page.waitForURL('**/login**', { timeout: 8000 }).catch(() => null);
await page.keyboard.press('Enter');
await redirect;
await page.waitForTimeout(1500);
const finalUrl = page.url();
const modalVisible = await dialog.isVisible().catch(() => false);
await page.screenshot({ path: path.join(OUTDIR, `extend-session-${PHASE}-02-outcome.png`) });

log('');
log(`[result] URL before "Stay Logged In": ${placeUrl}`);
log(`[result] URL after:                   ${finalUrl}`);
log(`[result] warning modal still visible: ${modalVisible}`);
if (finalUrl.includes('/login')) {
  log('[result] VERDICT: user was force-logged-out to /login — their place is gone (pre-fix behavior)');
} else {
  log('[result] VERDICT: user kept their session and their place (post-fix behavior)');
}

await context.close(); // flushes the video
const video = await page.video()?.path();
if (video) {
  const dest = path.join(OUTDIR, `extend-session-${PHASE}.webm`);
  fs.copyFileSync(video, dest);
  fs.rmSync(path.join(OUTDIR, 'video-tmp'), { recursive: true, force: true });
  log(`[artifact] recording: ${dest}`);
}
await browser.close();

fs.writeFileSync(path.join(OUTDIR, `extend-session-${PHASE}-transcript.txt`), lines.join('\n') + '\n');
console.log(`transcript written to ${OUTDIR}/extend-session-${PHASE}-transcript.txt`);
