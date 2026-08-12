// Whole-dist bundle totals: raw + gzip, JS + CSS + html.
//
// `smattr.mjs` attributes bytes *within one chunk*; it deliberately says nothing
// about the bundle as a whole. The AUDIT_REPORT Category 2 headline
// ("2,321.58 kB raw / 700.93 kB gzip (JS + CSS + html)") is a sum across every
// emitted asset, which was computed ad hoc during the audit. This script makes
// that sum reproducible so "after" numbers are comparable to the baseline.
//
// kB = 1000 bytes, matching Vite's own build report and smattr.mjs.
//
// Usage: node bench/cat2-bundle/total.mjs web/dist

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const root = process.argv[2] || 'web/dist';

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Sourcemaps are a build artefact, not shipped payload — excluded, as in the baseline.
const COUNTED = new Set(['.js', '.css', '.html']);

const files = walk(root).filter((f) => COUNTED.has(path.extname(f)) && !f.endsWith('.map'));

const rows = files.map((f) => {
  const buf = fs.readFileSync(f);
  return {
    file: path.relative(root, f).replace(/\\/g, '/'),
    ext: path.extname(f),
    raw: buf.length,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
  };
});

const K = (n) => (n / 1000).toFixed(2).padStart(10);
const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);

const byExt = new Map();
for (const r of rows) {
  const cur = byExt.get(r.ext) || { n: 0, raw: 0, gzip: 0 };
  cur.n++; cur.raw += r.raw; cur.gzip += r.gzip;
  byExt.set(r.ext, cur);
}

console.log(`DIST ${root}`);
console.log('\n--- BY TYPE ---');
console.log('     type   count     raw kB    gzip kB');
for (const [ext, v] of [...byExt.entries()].sort((a, b) => b[1].raw - a[1].raw)) {
  console.log(`${ext.padStart(9)}${String(v.n).padStart(8)}${K(v.raw)}${K(v.gzip)}`);
}

console.log('\n--- TOTAL (JS + CSS + html) ---');
console.log(`  files:  ${rows.length}`);
console.log(`  raw:  ${K(sum(rows, 'raw'))} kB`);
console.log(`  gzip: ${K(sum(rows, 'gzip'))} kB`);

// Initial-load subset: html + CSS + the entry chunk (index-*.js), matching the
// baseline's "Initial-load subset" line.
const initial = rows.filter(
  (r) => r.ext === '.html' || r.ext === '.css' || /^assets\/index-[^/]*\.js$/.test(r.file)
);
console.log('\n--- INITIAL-LOAD SUBSET (html + CSS + entry chunk) ---');
for (const r of initial) console.log(`  ${r.file}  raw ${K(r.raw)} kB  gzip ${K(r.gzip)} kB`);
console.log(`  raw:  ${K(sum(initial, 'raw'))} kB`);
console.log(`  gzip: ${K(sum(initial, 'gzip'))} kB`);

console.log('\n--- TOP 10 CHUNKS BY RAW ---');
[...rows].sort((a, b) => b.raw - a.raw).slice(0, 10)
  .forEach((r) => console.log(`${K(r.raw)} kB raw ${K(r.gzip)} kB gzip  ${r.file}`));
