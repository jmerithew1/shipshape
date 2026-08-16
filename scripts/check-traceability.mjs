#!/usr/bin/env node
/**
 * Guard for docs/week6-traceability.md.
 *
 * WHY THIS EXISTS. That file's whole value is that its numbers are computed
 * rather than asserted — it was written because a hard-gate row claimed five
 * measurements on the strength of one. Twice since, its own numbers drifted:
 *
 *   - the summary block was first written from memory and was wrong in every
 *     figure;
 *   - three section headings declared row counts their tables did not have,
 *     after rows were added and the headings were not;
 *   - an edit left a SECOND, superseded summary table thirty lines below the
 *     current one, so the document contradicted itself.
 *
 * Every one of those was found by a human or an audit reading carefully. That
 * is the wrong mechanism for an arithmetic invariant, so this checks it:
 *
 *   1. exactly one summary table exists;
 *   2. its totals equal a recount of the status cells;
 *   3. every "Section name (N)" heading matches the rows beneath it.
 *
 *   node scripts/check-traceability.mjs
 *
 * Exits non-zero with the specific mismatch. Wired into `pnpm lint:docs` and
 * the pre-commit hook.
 */
import { readFileSync } from 'node:fs';

const FILE = 'docs/week6-traceability.md';
const STATUSES = ['OWED', 'PARTIAL', 'ACCRUING', 'MET'];

/** A markdown table row that carries data (not a separator, not a header). */
const isDataRow = (line, headerPattern) =>
  line.startsWith('|') &&
  !/^\|\s*[-: ]+\|/.test(line) &&
  !headerPattern.test(line);

const HEADER = /\|\s*(#|Requirement|Metric|Capability|Pick|Deliverable|Rule|Scenario|Flow|Stage|Brief specifies|Brief clause|Mark|Row|Was open|Item)\s*\|/;

/**
 * Status precedence matters: a row reading "MET (API) / PARTIAL (click)" is
 * PARTIAL. Checking MET first would silently upgrade every caveated row.
 */
function statusOf(line) {
  const upper = line.toUpperCase();
  return STATUSES.find((s) => upper.includes(s)) ?? null;
}

const text = readFileSync(FILE, 'utf8');
const lines = text.split('\n');
const errors = [];

// ── 1. Exactly one summary table ────────────────────────────────────────────
const summaryRows = lines.filter((l) => /^\|\s*MET\s*\|\s*\*\*\d+\*\*\s*\|/.test(l));
if (summaryRows.length !== 1) {
  errors.push(
    `expected exactly 1 summary table, found ${summaryRows.length}. ` +
      `Two summary tables means the document contradicts itself.`
  );
}

// ── 2 & 3. Walk sections, counting rows and reading declared counts ─────────
const bodyStart = lines.findIndex((l) => l.startsWith('## A.'));
const bodyEnd = lines.findIndex((l, i) => i > bodyStart && /^## (A citation|Open items)/.test(l));
if (bodyStart === -1 || bodyEnd === -1) {
  console.error(`${FILE}: could not locate the requirement sections — has the layout changed?`);
  process.exit(1);
}

const tally = Object.fromEntries(STATUSES.map((s) => [s, 0]));
let section = null;
let declared = null;
let rows = 0;

const closeSection = () => {
  if (section && declared !== null && rows !== declared) {
    errors.push(`heading "${section}" declares ${declared} rows, table has ${rows}`);
  }
};

for (const line of lines.slice(bodyStart, bodyEnd)) {
  if (line.startsWith('## ') || line.startsWith('### ')) {
    closeSection();
    const m = /\((\d+)\)\s*$/.exec(line);
    section = line.replace(/^#+\s*/, '').trim();
    declared = m ? Number(m[1]) : null;
    rows = 0;
    continue;
  }
  if (!isDataRow(line, HEADER)) continue;
  // The A9 detail table lists flows, not requirements; it ends in a verdict.
  if (/\|\s*PASS\s*\|\s*$/.test(line)) continue;
  if (line.includes('Not selected')) continue;
  rows += 1;
  const status = statusOf(line);
  if (status) tally[status] += 1;
}
closeSection();

// ── Compare the tally against the summary table ─────────────────────────────
const stated = {};
for (const s of STATUSES) {
  const re = new RegExp(`^\\|\\s*${s}[^|]*\\|\\s*\\*\\*(\\d+)\\*\\*`, 'im');
  const m = re.exec(text);
  if (m) stated[s] = Number(m[1]);
}
for (const s of STATUSES) {
  if (stated[s] !== undefined && stated[s] !== tally[s]) {
    errors.push(`summary says ${s} = ${stated[s]}, tables contain ${tally[s]}`);
  }
}

const total = STATUSES.reduce((n, s) => n + tally[s], 0);
const statedTotal = /(\d+)\s+requirement\s+rows/i.exec(text);
if (statedTotal && Number(statedTotal[1]) !== total) {
  errors.push(`summary says ${statedTotal[1]} requirement rows, tables contain ${total}`);
}

if (errors.length) {
  console.error(`${FILE} — traceability invariants violated:\n`);
  for (const e of errors) console.error(`  · ${e}`);
  console.error(`\nThese numbers are the document's entire claim. Fix the file, not this check.`);
  process.exit(1);
}

console.log(
  `${FILE}: ${total} rows — ` +
    STATUSES.map((s) => `${s} ${tally[s]}`).join(' · ') +
    ' — summary and section headings agree'
);
