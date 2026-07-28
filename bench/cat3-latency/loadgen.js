// Precise closed-loop load generator. Records exact per-request latency,
// TTFB (server think time) and total (adds response transfer), plus status codes.
// Usage: node loadgen.js <path> <conns> <amount> <sessionId> [warmup]
const http = require('http');

const [, , PATH, CONNS_S, AMOUNT_S, SID, WARM_S] = process.argv;
const CONNS = +CONNS_S, AMOUNT = +AMOUNT_S, WARM = +(WARM_S || 0);

const agent = new http.Agent({ keepAlive: true, maxSockets: CONNS, maxFreeSockets: CONNS });

function one() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let ttfb = null, bytes = 0;
    const req = http.request(
      { host: '127.0.0.1', port: 3000, path: PATH, method: 'GET', agent,
        headers: { Cookie: `session_id=${SID}`, 'Accept-Encoding': 'identity' } },
      (res) => {
        res.on('data', (c) => { if (ttfb === null) ttfb = process.hrtime.bigint(); bytes += c.length; });
        res.on('end', () => {
          const t1 = process.hrtime.bigint();
          resolve({ status: res.statusCode, bytes,
            total: Number(t1 - t0) / 1e6,
            ttfb: ttfb === null ? Number(t1 - t0) / 1e6 : Number(ttfb - t0) / 1e6 });
        });
      });
    req.on('error', (e) => resolve({ status: 0, err: e.code, bytes: 0, total: 0, ttfb: 0 }));
    req.end();
  });
}

// exact nearest-rank percentile
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.ceil(p / 100 * a.length) - 1)] : NaN;

async function phase(n, collect) {
  const out = [];
  let issued = 0;
  await new Promise((done) => {
    let active = 0, finished = 0;
    const pump = () => {
      while (active < CONNS && issued < n) {
        active++; issued++;
        one().then((r) => {
          active--; finished++;
          if (collect) out.push(r);
          if (finished === n) done(); else pump();
        });
      }
    };
    pump();
  });
  return out;
}

(async () => {
  if (WARM) await phase(WARM, false);
  const t0 = Date.now();
  const res = await phase(AMOUNT, true);
  const wall = (Date.now() - t0) / 1000;

  const codes = {};
  for (const r of res) codes[r.err || r.status] = (codes[r.err || r.status] || 0) + 1;
  const ok = res.filter((r) => r.status >= 200 && r.status < 300);
  const tot = ok.map((r) => r.total).sort((a, b) => a - b);
  const ttf = ok.map((r) => r.ttfb).sort((a, b) => a - b);
  const f = (x) => (isNaN(x) ? 'n/a' : x.toFixed(1));

  console.log(JSON.stringify({
    path: PATH, conns: CONNS, amount: AMOUNT, wall_s: +wall.toFixed(2),
    rps: +(res.length / wall).toFixed(0), codes,
    kb_per_resp: ok.length ? +(ok[0].bytes / 1024).toFixed(1) : 0,
    total: { p50: +f(pct(tot, 50)), p95: +f(pct(tot, 95)), p99: +f(pct(tot, 99)),
             avg: +f(tot.reduce((s, v) => s + v, 0) / (tot.length || 1)), max: +f(tot[tot.length - 1]) },
    ttfb:  { p50: +f(pct(ttf, 50)), p95: +f(pct(ttf, 95)), p99: +f(pct(ttf, 99)) },
  }));
})();
