/**
 * Gap 1 visual evidence — silent migration failure vs. loud failure, on camera.
 *
 * Re-executes the two committed transcript scenarios (fresh install; broken
 * migration on an existing database) while rendering the real child-process
 * output live into a terminal viewer page recorded by Chromium. The pixels are
 * a live render of the actual `tsx src/db/migrate.ts` stdout/stderr — no text
 * is staged. After each run the script queries schema_migrations through psql
 * in the postgres container, so the video shows the lie (exit 0, 9 stamped)
 * next to the truth (exit 1, file named, nothing half-applied).
 *
 *   Pre-fix (before f3c89c5): fresh install dies at 010_oauth_state.sql,
 *   prints "already exists, continuing...", exits 0 — deploy proceeds against
 *   a half-migrated database. A broken migration is swallowed the same way.
 *   Post-fix: fresh installs baseline-stamp every migration; a failing
 *   migration names the file, rolls back, and exits 1.
 *
 * Usage (repo root; docker compose postgres up on :5433):
 *   PHASE=after  node docs/pr-evidence/week4-cat6/capture-migrate-run.mjs
 * For PHASE=before, first:
 *   git show f3c89c5~1:api/src/db/migrate.ts > api/src/db/migrate.ts
 * then run with PHASE=before, then: git checkout -- api/src/db/migrate.ts
 */
import { chromium } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PHASE = process.env.PHASE ?? 'after';
const OUTDIR = 'docs/pr-evidence/week4-cat6';
const DB = 'week4_cat6_video';
const DB_URL = `postgresql://ship:ship_dev_password@localhost:5433/${DB}`;
const PSQL = ['compose', '-f', 'docker-compose.local.yml', 'exec', '-T', 'postgres', 'psql', '-U', 'ship', '-d', 'postgres', '-tAc'];
const BROKEN = 'api/src/db/migrations/999_broken_repro.sql';

const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

const migrateHash = execSync('git hash-object api/src/db/migrate.ts').toString().trim();
log(`=== ${new Date().toISOString()} — capture-migrate-run PHASE=${PHASE} ===`);
log(`=== api/src/db/migrate.ts @ ${migrateHash} (git hash-object) ===`);
log('');

function psql(sql, db = 'postgres') {
  const args = [...PSQL];
  args[args.indexOf('postgres', 6)] = db; // -d target
  return execSync(`docker ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')} ${JSON.stringify(sql)}`)
    .toString().trim();
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: path.join(OUTDIR, 'video-tmp'), size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
await page.setContent(`
  <body style="margin:0;background:#101512;color:#d9e2dc;font:13px/1.5 Consolas,monospace;padding:24px">
    <div style="color:#8fa89b;border-bottom:1px solid #2a352f;padding-bottom:8px;margin-bottom:12px">
      Gap 1 evidence — PHASE=${PHASE} · api/src/db/migrate.ts @ ${migrateHash.slice(0, 12)}…
    </div>
    <pre id="t" style="white-space:pre-wrap;margin:0"></pre>
  </body>`);
const emit = async (s) => {
  log(s);
  await page.evaluate((line) => {
    const t = document.getElementById('t');
    t.textContent += line + '\n';
    window.scrollTo(0, document.body.scrollHeight);
  }, s);
};

async function runMigrate(title) {
  await emit('');
  await emit(`$ ${title}`);
  await emit(`$ DATABASE_URL=postgresql://ship:***@localhost:5433/${DB} tsx src/db/migrate.ts   (cwd: api/)`);
  // tsx invoked via its bin shim directly, NOT `pnpm exec`: pnpm prints a
  // misleading "Command tsx not found" epilogue after any non-zero child
  // exit, which would put tool noise in the exact frame that matters.
  const tsxBin = path.join('node_modules', '.bin', 'tsx');
  const child = spawn(tsxBin, ['src/db/migrate.ts'], {
    cwd: 'api',
    env: { ...process.env, DATABASE_URL: DB_URL },
    shell: true,
  });
  let buf = '';
  const onData = (d) => { buf += d.toString(); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const flush = setInterval(async () => {
    if (buf) { const out = buf; buf = ''; for (const l of out.split(/\r?\n/)) if (l.trim()) await emit('  ' + l); }
  }, 400);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearInterval(flush);
  if (buf) for (const l of buf.split(/\r?\n/)) if (l.trim()) await emit('  ' + l);
  await emit(`  exit=${code}`);
  const stamped = psql('SELECT count(*) FROM schema_migrations', DB);
  await emit(`  schema_migrations stamped: ${stamped}`);
  return { code, stamped: Number(stamped) };
}

// --- Scenario 1: fresh install -----------------------------------------------
await emit(`[scenario 1] fresh install — empty database "${DB}"`);
try { psql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { psql(`DROP DATABASE IF EXISTS ${DB}`); }
psql(`CREATE DATABASE ${DB}`);
const totalFiles = fs.readdirSync('api/src/db/migrations').filter((f) => f.endsWith('.sql')).length;
await emit(`  (migration files on disk: ${totalFiles})`);
const s1 = await runMigrate('scenario 1: migrate against the empty database');
await emit(s1.code === 0 && s1.stamped >= totalFiles
  ? `  VERDICT: exit 0 and all ${totalFiles} migrations accounted for — deploy may proceed (post-fix behavior)`
  : `  VERDICT: exit ${s1.code} with ${s1.stamped}/${totalFiles} stamped — a green exit code on a half-migrated database (pre-fix behavior)`);
await page.screenshot({ path: path.join(OUTDIR, `migrate-${PHASE}-01-fresh.png`), fullPage: true });

// --- Scenario 2: broken migration on an existing database --------------------
await emit('');
await emit(`[scenario 2] broken migration on the existing database (999_broken_repro.sql: "THIS IS NOT SQL;")`);
fs.writeFileSync(BROKEN, 'THIS IS NOT SQL;\n');
let s2;
try {
  s2 = await runMigrate('scenario 2: migrate with a failing migration present');
} finally {
  fs.rmSync(BROKEN, { force: true });
}
await emit(s2.code !== 0
  ? '  VERDICT: failing migration named, rolled back, exit 1 — the deploy stops (post-fix behavior)'
  : '  VERDICT: exit 0 with the failure swallowed — the deploy proceeds as if nothing happened (pre-fix behavior)');
await page.screenshot({ path: path.join(OUTDIR, `migrate-${PHASE}-02-broken.png`), fullPage: true });
await page.waitForTimeout(1200);

await context.close();
const video = await page.video()?.path();
if (video) {
  const dest = path.join(OUTDIR, `migrate-${PHASE}.webm`);
  fs.copyFileSync(video, dest);
  fs.rmSync(path.join(OUTDIR, 'video-tmp'), { recursive: true, force: true });
  log(`[artifact] recording: ${dest}`);
}
await browser.close();

fs.writeFileSync(path.join(OUTDIR, `migrate-${PHASE}-transcript.txt`), lines.join('\n') + '\n');
console.log(`transcript written to ${OUTDIR}/migrate-${PHASE}-transcript.txt`);
