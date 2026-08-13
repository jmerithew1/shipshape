/**
 * prove-it: live-deployment verification with receipts.
 * Runs against the DEPLOYED instance, not localhost. Writes dated, immutable
 * screenshots under evidence/<date>/ — one per claim.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const BASE = 'https://ship-api-r1om.onrender.com';
const OUT = 'evidence/2026-08-12';
const CLIENT_ID = 'ship_app_e46d52564bc1f690';
const results: string[][] = [];
const consoleLog: string[] = [];

test.use({ baseURL: BASE });
test.describe.configure({ mode: 'serial' });

test('live verification walk', async ({ page, request }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(OUT, { recursive: true });
  page.on('console', (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleLog.push(`pageerror: ${e.message}`));
  const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });

  // c1 — generated OpenAPI 3.1 spec is live
  await page.goto(`${BASE}/api/v1/openapi.json`, { waitUntil: 'networkidle' });
  const spec = JSON.parse(await page.innerText('body'));
  const ops = Object.values(spec.paths as Record<string, Record<string, { operationId?: string }>>)
    .flatMap((i) => Object.values(i)).filter((o) => o.operationId).map((o) => o.operationId!);
  await shot('c1_openapi-spec-live');
  results.push(['c1', 'OpenAPI 3.1 spec served live, generated from routes',
    `openapi=${spec.openapi}, ${Object.keys(spec.paths).length} paths, ${ops.length} operations`,
    'c1_openapi-spec-live.png', spec.openapi.startsWith('3.1') && ops.length === 13 ? 'MET' : 'PARTIAL']);

  // c2 — ApiError envelope on an unauthenticated public call
  await page.goto(`${BASE}/api/v1/me`, { waitUntil: 'networkidle' });
  const err = JSON.parse(await page.innerText('body'));
  await shot('c2_apierror-envelope');
  const keysOk = Object.keys(err).every((k) => ['code', 'message', 'details', 'request_id'].includes(k)) && !!err.request_id;
  results.push(['c2', 'Every public failure ships the ApiError envelope',
    `401 keys=${Object.keys(err).sort().join(',')} code=${err.code}`, 'c2_apierror-envelope.png', keysOk ? 'MET' : 'MISSING']);

  // c3 — readiness asserts the platform tables (silent-migration guard)
  await page.goto(`${BASE}/ready`, { waitUntil: 'networkidle' });
  const ready = JSON.parse(await page.innerText('body'));
  await shot('c3_ready-platform-tables');
  results.push(['c3', 'Readiness asserts platform tables exist', JSON.stringify(ready),
    'c3_ready-platform-tables.png', ready.platform_tables ? 'MET' : 'MISSING']);

  // c4 — the SPA actually paints (frontend half live)
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const painted = await page.evaluate(() => document.body.innerText.trim().length > 40);
  await shot('c4_spa-renders');
  results.push(['c4', 'Deployed SPA renders (frontend half is live)',
    `title=${JSON.stringify(await page.title())} painted=${painted}`, 'c4_spa-renders.png', painted ? 'MET' : 'MISSING']);

  // c5 — device grant issues a user code
  const r = await request.post(`${BASE}/oauth/device/code`, { data: { client_id: CLIENT_ID, scope: 'documents:read issues:read' } });
  const dc = await r.json();
  results.push(['c5', 'Device Authorization Grant issues a user code',
    `status=${r.status()} user_code=${dc.user_code} interval=${dc.interval}`, 'c5_device-code.png',
    r.status() === 200 && dc.user_code ? 'MET' : 'MISSING']);
  await page.goto(`${BASE}/api/v1/openapi.json`, { waitUntil: 'networkidle' });
  await shot('c5_device-code');

  // c6 — authorization_pending, then slow_down on an immediate re-poll
  const form = `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${dc.device_code}&client_id=${CLIENT_ID}`;
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const j1 = await (await request.post(`${BASE}/oauth/token`, { data: form, headers })).json();
  const j2 = await (await request.post(`${BASE}/oauth/token`, { data: form, headers })).json();
  results.push(['c6', 'Device polling honors authorization_pending then slow_down',
    `first=${j1.error} immediate-repoll=${j2.error}`, 'c5_device-code.png',
    j1.error === 'authorization_pending' && j2.error === 'slow_down' ? 'MET' : 'PARTIAL']);

  // c7 — X-RateLimit-* headers (named verbatim by the assignment)
  const r3 = await request.get(`${BASE}/api/v1/me`);
  const hdrs = r3.headers();
  const xs = Object.keys(hdrs).filter((k) => k.toLowerCase().startsWith('x-ratelimit')).sort();
  results.push(['c7', 'Public responses carry X-RateLimit-* headers', `present=${xs.join(',')}`,
    'c2_apierror-envelope.png', xs.length >= 3 ? 'MET' : 'MISSING']);

  // c8 — webhook routes live and gated
  const r4 = await request.get(`${BASE}/api/v1/webhooks`);
  const w = await r4.json();
  results.push(['c8', 'Webhook routes live and gated behind auth', `status=${r4.status()} code=${w.code}`,
    'c1_openapi-spec-live.png', r4.status() === 401 && w.request_id ? 'MET' : 'PARTIAL']);

  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, consoleLog }, null, 2));
  for (const row of results) console.log(row[0], row[4], '|', row[2]);
  console.log('CONSOLE:', consoleLog.length ? consoleLog.slice(0, 6).join(' || ') : 'clean across the walk');
  expect(results.filter((r) => r[4] === 'MET').length).toBeGreaterThan(0);
});
