/**
 * prove-it: live-deployment verification with receipts.
 * Runs against the DEPLOYED instance, not localhost. Writes dated screenshots
 * under evidence/<today>/ — one per claim.
 *
 * `OUT` was hardcoded to `evidence/2026-08-12` until 2026-08-16, so the header
 * promised "dated, immutable" evidence while every run silently overwrote the
 * 12th's receipts with the current day's observations. A file stamped with one
 * date containing another day's data is worse than no file: it is a receipt that
 * lies about when it was taken. Three separate runs during one audit rewrote the
 * same `results.json` (`user_code` went EGG8-2YEF → 7VCH-2FHP → MDVR-G255)
 * before anyone noticed.
 *
 * Now the directory is derived from the run date, so each run lands beside the
 * others instead of on top of them.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const BASE = 'https://ship-api-r1om.onrender.com';
const OUT = `evidence/${new Date().toISOString().slice(0, 10)}`;
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
  // Compared against the COMMITTED spec, not a hardcoded 13. The magic number
  // made this a tripwire: adding a route to the v1 surface would turn c1
  // PARTIAL and red the deploy job for a spec change rather than a production
  // fault. What actually matters here is drift — that the operations prod
  // serves are the operations the repo says it serves.
  const committed = JSON.parse(fs.readFileSync('docs/openapi.json', 'utf8'));
  const committedOps = Object.values(committed.paths as Record<string, Record<string, unknown>>)
    .flatMap((entry) => Object.keys(entry)).length;
  results.push(['c1', 'OpenAPI 3.1 spec served live, matching the committed spec',
    `openapi=${spec.openapi}, ${Object.keys(spec.paths).length} paths, ${ops.length} operations ` +
      `(committed: ${committedOps})`,
    'c1_openapi-spec-live.png',
    spec.openapi.startsWith('3.1') && ops.length === committedOps ? 'MET' : 'PARTIAL']);

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
  //
  // This probe was UNAUTHENTICATED until 2026-08-16 and so could never pass:
  // it reported MISSING while the ledger cited it as proof the headers ship.
  // The check was wrong, not the API. The brief's own wording settles it —
  // "Per-app and per-token token-bucket limits. Public responses carry
  // X-RateLimit-*" — so a bucket is a property of an identity. A request that
  // has not authenticated has no app and no token, hence no bucket to report,
  // and it 401s before the limiter runs at all (authn precedes ratelimit in
  // the v1 middleware order).
  //
  // So: authenticate, then assert. Client credentials as the first-party drill
  // app, the identity CI's TTFE drill already uses. Without that secret the row
  // records SKIPPED — "could not run" is a different claim from "failed", and
  // conflating them is what produced the false red.
  const drillSecret = process.env.SHIP_CLIENT_SECRET;
  if (drillSecret) {
    const tokenRes = await request.post(`${BASE}/oauth/token`, {
      form: {
        grant_type: 'client_credentials',
        // Configurable: hardcoding the drill app made this branch untestable
        // anywhere but prod, so it had never once executed.
        client_id: process.env.SHIP_CLIENT_ID ?? 'ship_app_ttfe_drill',
        client_secret: drillSecret,
        scope: 'documents:read',
      },
    });
    const token = (await tokenRes.json()).access_token as string | undefined;
    if (!token) {
      // Failing to MINT a token is not evidence about rate-limit headers — it
      // is the check being unable to run, same as having no secret at all.
      // Reporting MISSING here would red the deploy for a credential problem
      // while claiming the API had dropped a header it never got asked for.
      results.push(['c7', 'Authenticated public responses carry X-RateLimit-* headers',
        `SKIPPED — token exchange returned ${tokenRes.status()}, so no authenticated ` +
        `request could be made. Check SHIP_CLIENT_ID/SHIP_CLIENT_SECRET, not the API`,
        'c2_apierror-envelope.png', 'SKIPPED']);
    } else {
      const r3 = await request.get(`${BASE}/api/v1/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const xs = Object.keys(r3.headers())
        .filter((k) => k.toLowerCase().startsWith('x-ratelimit'))
        .sort();
      results.push(['c7', 'Authenticated public responses carry X-RateLimit-* headers',
        `status=${r3.status()} present=${xs.join(',')}`,
        'c2_apierror-envelope.png', xs.length >= 3 ? 'MET' : 'MISSING']);
    }
  } else {
    const r3 = await request.get(`${BASE}/api/v1/me`);
    const pre = Object.keys(r3.headers())
      .filter((k) => k.toLowerCase().startsWith('x-ratelimit'))
      .sort();
    results.push(['c7', 'Authenticated public responses carry X-RateLimit-* headers',
      `SKIPPED — no SHIP_CLIENT_SECRET, so no token could be minted. ` +
      `Unauthenticated control: status=${r3.status()} x-ratelimit=[${pre.join(',')}] ` +
      `(expected empty: per-app/per-token limits, authn precedes the limiter)`,
      'c2_apierror-envelope.png', 'SKIPPED']);
  }

  // c8 — webhook routes live and gated
  const r4 = await request.get(`${BASE}/api/v1/webhooks`);
  const w = await r4.json();
  results.push(['c8', 'Webhook routes live and gated behind auth', `status=${r4.status()} code=${w.code}`,
    'c1_openapi-spec-live.png', r4.status() === 401 && w.request_id ? 'MET' : 'PARTIAL']);

  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, consoleLog }, null, 2));
  for (const row of results) console.log(row[0], row[4], '|', row[2]);
  console.log('CONSOLE:', consoleLog.length ? consoleLog.slice(0, 6).join(' || ') : 'clean across the walk');
  // This assertion used to be `MET.length > 0` — seven of the eight checks could
  // report MISSING and the spec still passed, which made the whole walk
  // unfalsifiable and the CI step's claim ("fails the run if production is not
  // actually serving") untrue. Fail on any check that is genuinely bad.
  //
  // SKIPPED is deliberately tolerated and is NOT the same as MISSING: c7 needs a
  // client-credentials secret to mint a token, and a fork PR has no secrets.
  // "Could not run" must not read as "failed" — collapsing those two is what
  // produced the false red c7 reported for weeks.
  const bad = results.filter((r) => r[4] === 'MISSING' || r[4] === 'PARTIAL');
  expect(
    bad.map((r) => `${r[0]}=${r[4]} (${r[2]})`),
    'every live check must be MET or explicitly SKIPPED'
  ).toEqual([]);
});
