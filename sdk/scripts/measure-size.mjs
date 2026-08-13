/**
 * Reproducible bundle-size receipt for @ship/sdk.
 *
 * The Week-6 target is "< 250 KB min+gzip". This package ships zero runtime
 * dependencies, so its footprint is just its own compiled output. We report the
 * gzipped size of the built ESM as the conservative upper bound — the dist is
 * the UNMINIFIED `tsc` output, so a real minified bundle would be smaller still.
 *
 * Run: `pnpm --filter @ship/sdk build && node scripts/measure-size.mjs`
 * Fails (exit 1) if the gzipped size regresses past the budget, so the number
 * in the docs can never quietly drift away from the artifact.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const BUDGET_KB = 250;

const jsFiles = readdirSync(distDir).filter((f) => f.endsWith('.js'));
if (jsFiles.length === 0) {
  console.error('No built output in dist/. Run `pnpm --filter @ship/sdk build` first.');
  process.exit(1);
}

let raw = 0;
const parts = [];
for (const f of jsFiles.sort()) {
  const buf = readFileSync(join(distDir, f));
  raw += buf.length;
  parts.push(buf);
}
const gzip = gzipSync(Buffer.concat(parts)).length;
const rawKB = raw / 1024;
const gzipKB = gzip / 1024;

console.log(`@ship/sdk bundle size (${jsFiles.length} ESM files, zero deps)`);
console.log(`  raw:  ${rawKB.toFixed(1)} KB`);
console.log(`  gzip: ${gzipKB.toFixed(1)} KB`);
console.log(`  budget: ${BUDGET_KB} KB min+gzip → using ${(gzipKB / BUDGET_KB * 100).toFixed(1)}% (unminified upper bound)`);

if (gzipKB > BUDGET_KB) {
  console.error(`\nFAIL: ${gzipKB.toFixed(1)} KB gzip exceeds the ${BUDGET_KB} KB budget.`);
  process.exit(1);
}
