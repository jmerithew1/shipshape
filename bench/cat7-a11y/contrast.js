// WCAG 2.1 contrast ratio calculator (throwaway audit script)
// Relative luminance per WCAG 2.1 SC 1.4.3 definition:
//   c_lin = c/12.92 if c <= 0.03928 else ((c+0.055)/1.055)^2.4
//   L = 0.2126 R + 0.7152 G + 0.0722 B
//   ratio = (L1 + 0.05) / (L2 + 0.05)

function hex(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
function lum(rgb) {
  const [r,g,b] = rgb.map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126*r + 0.7152*g + 0.0722*b;
}
function ratio(fg, bg) {
  const a = lum(typeof fg === 'string' ? hex(fg) : fg);
  const b = lum(typeof bg === 'string' ? hex(bg) : bg);
  const [hi, lo] = a > b ? [a,b] : [b,a];
  return (hi + 0.05) / (lo + 0.05);
}
// Simple alpha compositing (sRGB non-linear, which is what browsers do for
// `background-color: rgba()` painted over an opaque backdrop).
function over(fgHex, alpha, bgHex) {
  const f = hex(fgHex), b = hex(bgHex);
  return [0,1,2].map(i => Math.round(f[i]*alpha + b[i]*(1-alpha)));
}
function toHex(rgb){ return '#' + rgb.map(v=>v.toString(16).padStart(2,'0')).join(''); }

// ---- Tailwind v3 default palette (verified from web/node_modules/tailwindcss) ----
const T = {
  gray:{300:'#d1d5db',400:'#9ca3af',500:'#6b7280',600:'#4b5563'},
  red:{100:'#fee2e2',300:'#fca5a5',400:'#f87171',500:'#ef4444',600:'#dc2626',700:'#b91c1c'},
  orange:{300:'#fdba74',400:'#fb923c',500:'#f97316'},
  amber:{100:'#fef3c7',300:'#fcd34d',500:'#f59e0b',600:'#d97706'},
  yellow:{300:'#fde047',400:'#facc15',500:'#eab308',600:'#ca8a04'},
  green:{300:'#86efac',400:'#4ade80',500:'#22c55e',600:'#16a34a'},
  blue:{300:'#93c5fd',400:'#60a5fa',500:'#3b82f6',600:'#2563eb'},
  cyan:{300:'#67e8f9',400:'#22d3ee',500:'#06b6d4'},
  purple:{300:'#d8b4fe',400:'#c084fc',500:'#a855f7'},
};
// ---- App theme (web/tailwind.config.js + web/src/index.css) ----
const BG      = '#0d0d0d'; // index.css:20  body background-color
const FG      = '#f5f5f5'; // index.css:21  body color / theme.foreground
const MUTED   = '#8a8a8a'; // tailwind.config.js:14  theme.muted
const BORDER  = '#262626'; // tailwind.config.js:15
const ACCENT  = '#005ea2'; // tailwind.config.js:16
const ACCENTH = '#0071bc'; // tailwind.config.js:17
const SURFACE = '#1a1a1a'; // index.css:119/127  code + panel surface

const rows = [];
function add(group, label, fg, bg, note, kind) {
  rows.push({ group, label, fg, bg, r: ratio(fg,bg), note: note||'', kind: kind||'text' });
}

// === 1. Core text ===
add('CORE', 'body text #f5f5f5 on bg #0d0d0d', FG, BG, 'index.css:20-21');
add('CORE', 'muted #8a8a8a on bg #0d0d0d', MUTED, BG, 'tailwind.config.js:14 (claims 5.1:1)');
add('CORE', 'muted #8a8a8a on surface #1a1a1a', MUTED, SURFACE, 'muted text inside cards/code');
add('CORE', 'placeholder #525252 on bg #0d0d0d', '#525252', BG, 'index.css:84 editor placeholder');
add('CORE', 'drag-handle #525252 on bg #0d0d0d', '#525252', BG, 'index.css:287', 'ui');
add('CORE', 'blockquote #a3a3a3 on bg #0d0d0d', '#a3a3a3', BG, 'index.css:249');
add('CORE', 'input::placeholder #8a8a8a on #0d0d0d', MUTED, BG, 'index.css:51 (claims 5.1:1)');

// === 2. Primary button / accent ===
add('ACCENT', 'white text on bg-accent #005ea2', '#ffffff', ACCENT, 'ActionItemsModal.tsx:247 etc.');
add('ACCENT', 'white text on bg-accent-hover #0071bc', '#ffffff', ACCENTH, 'DashboardVariantC.tsx:265 hover');
add('ACCENT', 'text-accent #005ea2 on bg #0d0d0d', ACCENT, BG, 'DashboardSidebar.tsx:36,51 active nav');
add('ACCENT', 'text-accent #005ea2 on bg-accent/10 over #0d0d0d', ACCENT, toHex(over(ACCENT,0.10,BG)), 'DashboardSidebar.tsx:36 active nav pill');
add('ACCENT', 'focus ring #005ea2 vs bg #0d0d0d', ACCENT, BG, 'index.css:28 :focus-visible outline', 'ui');
add('ACCENT', 'border #262626 vs bg #0d0d0d', BORDER, BG, 'tailwind.config.js:15 component boundary', 'ui');

// === 3. statusColors.ts pills: bg-<c>-500/20 over page bg, fg <c>-300 ===
const A = 0.20;
const pills = [
  ['issueStatus triage',      'purple', 300, 'statusColors.ts:7'],
  ['issueStatus backlog',     'gray',   300, 'statusColors.ts:8'],
  ['issueStatus todo',        'blue',   300, 'statusColors.ts:9'],
  ['issueStatus in_progress', 'yellow', 300, 'statusColors.ts:10'],
  ['issueStatus in_review',   'cyan',   300, 'statusColors.ts:11'],
  ['issueStatus done',        'green',  300, 'statusColors.ts:12'],
  ['issueStatus cancelled',   'red',    300, 'statusColors.ts:13'],
  ['sprintStatus planned',    'gray',   300, 'statusColors.ts:17'],
  ['sprintStatus upcoming',   'blue',   300, 'statusColors.ts:18'],
  ['sprintStatus active',     'green',  300, 'statusColors.ts:19'],
  ['sprintStatus completed',  'gray',   300, 'statusColors.ts:20'],
];
for (const [label, c, shade, note] of pills) {
  const bg = toHex(over(T[c][500], A, BG));
  add('PILL (statusColors.ts)', `${label}: ${c}-${shade} on ${c}-500/20 [${bg}]`, T[c][shade], bg, note);
}
// pill fg also has to read against the PAGE bg where the /20 wash is nearly invisible
for (const [label, c, shade, note] of pills.slice(0,7)) {
  add('PILL vs page bg', `${label}: ${c}-${shade} on page #0d0d0d`, T[c][shade], BG, note);
}

// === 4. priorityColors.ts (text only, no pill bg) ===
add('PRIORITY (statusColors.ts)', 'urgent: red-300 on #0d0d0d',    T.red[300],    BG, 'statusColors.ts:24');
add('PRIORITY (statusColors.ts)', 'high: orange-300 on #0d0d0d',   T.orange[300], BG, 'statusColors.ts:25');
add('PRIORITY (statusColors.ts)', 'medium: yellow-300 on #0d0d0d', T.yellow[300], BG, 'statusColors.ts:26');
add('PRIORITY (statusColors.ts)', 'low: blue-300 on #0d0d0d',      T.blue[300],   BG, 'statusColors.ts:27');

// === 5. Pills that BYPASS statusColors.ts (hardcoded in components) ===
const off = [
  ['red-400 on red-500/20',    T.red[400],    T.red[500],    0.20, 'FeedbackPanel/etc (4 sites)'],
  ['red-300 on red-500/20',    T.red[300],    T.red[500],    0.20, ''],
  ['red-600 on red-500/20',    T.red[600],    T.red[500],    0.20, 'ProjectRetro.tsx:229, WeekReview.tsx:175'],
  ['green-600 on green-500/20',T.green[600],  T.green[500],  0.20, 'ProjectRetro.tsx:212, WeekReview.tsx:161'],
  ['green-500 on green-500/20',T.green[500],  T.green[500],  0.20, ''],
  ['green-400 on green-500/20',T.green[400],  T.green[500],  0.20, ''],
  ['yellow-400 on yellow-500/20',T.yellow[400],T.yellow[500],0.20, ''],
  ['amber-300 on amber-500/20',T.amber[300],  T.amber[500],  0.20, ''],
  ['gray-400 on gray-500/20',  T.gray[400],   T.gray[500],   0.20, ''],
  ['blue-400 on blue-500/20',  T.blue[400],   T.blue[500],   0.20, ''],
  ['amber-600 on amber-500/10',T.amber[600],  T.amber[500],  0.10, 'Documents.tsx:363'],
  ['blue-600 on blue-500/10',  T.blue[600],   T.blue[500],   0.10, 'Documents.tsx:364'],
  ['orange-500 on orange-500/10',T.orange[500],T.orange[500],0.10, 'Projects.tsx:497'],
  ['yellow-500 on yellow-500/10',T.yellow[500],T.yellow[500],0.10,'QualityAssistant.tsx:110'],
  ['green-500 on green-500/10',T.green[500],  T.green[500],  0.10, 'QualityAssistant.tsx:111'],
  ['blue-500 on blue-500/10',  T.blue[500],   T.blue[500],   0.10, 'QualityAssistant.tsx:112'],
  ['red-500 on red-500/10',    T.red[500],    T.red[500],    0.10, 'QualityAssistant.tsx:113, InviteAccept.tsx:220'],
  ['yellow-600 on yellow-500/10',T.yellow[600],T.yellow[500],0.10,'ProjectRetro.tsx:159, WeekReview.tsx:134'],
];
for (const [label, fg, base, a, note] of off) {
  const bg = toHex(over(base, a, BG));
  add('PILL (bypasses statusColors)', `${label} [${bg}]`, fg, bg, note);
}
add('PILL (bypasses statusColors)', 'red-600 on plain page bg #0d0d0d', T.red[600], BG, 'Documents.tsx:436 delete button');

// === 6. index.css mention chips (rgba wash over page bg) ===
const mentions = [
  ['.mention / .mention-document', '#5e6ad2', '#5e6ad2', 0.10, 'index.css:323-325, 348-350'],
  ['.mention-person',              '#22c55e', '#22c55e', 0.10, 'index.css:338-340'],
  ['.mention-issue',               '#f59e0b', '#f59e0b', 0.10, 'index.css:353-355'],
  ['.mention-project',             '#06b6d4', '#06b6d4', 0.10, 'index.css:363-365'],
  ['.mention-program',             '#a855f7', '#a855f7', 0.10, 'index.css:373-375'],
  ['.mention-archived',            '#9ca3af', '#9ca3af', 0.10, 'index.css:384-386'],
  ['.mention-broken',              '#ef4444', '#ef4444', 0.10, 'index.css:395-397'],
];
for (const [label, fg, base, a, note] of mentions) {
  const bg = toHex(over(base, a, BG));
  add('MENTION CHIP (index.css)', `${label} [${bg}]`, fg, bg, note);
}

// === 7. Code block syntax highlighting on #1a1a1a ===
const hl = [
  ['hljs base #e5e7eb', '#e5e7eb', 'index.css:144'],
  ['hljs-comment #8b949e', '#8b949e', 'index.css:159'],
  ['hljs-keyword #ff7b72', '#ff7b72', 'index.css:166'],
  ['hljs-title #79c0ff', '#79c0ff', 'index.css:174'],
  ['hljs-string #a5d6ff', '#a5d6ff', 'index.css:179'],
  ['hljs-literal #d2a8ff', '#d2a8ff', 'index.css:185'],
  ['hljs-attr #ffa657', '#ffa657', 'index.css:191'],
  ['hljs-name #7ee787', '#7ee787', 'index.css:197'],
];
for (const [label, fg, note] of hl) add('CODE (on #1a1a1a)', label, fg, SURFACE, note);

// ---- print ----
const AA = 4.5, LARGE = 3.0;
let cur = null;
const w = [58, 9, 9, 8];
function pad(s,n){ s=String(s); return s.length>n ? s.slice(0,n) : s.padEnd(n); }
let fails = 0, total = 0, largeOnly = 0;
for (const r of rows) {
  if (r.group !== cur) {
    cur = r.group;
    console.log('\n' + '='.repeat(104));
    console.log('  ' + cur);
    console.log('='.repeat(104));
    console.log(pad('PAIR',58) + pad('RATIO',9) + pad('AA 4.5',9) + pad('3:1',8) + 'SOURCE');
    console.log('-'.repeat(104));
  }
  total++;
  const thr = r.kind === 'ui' ? LARGE : AA;
  const passAA = r.r >= AA, pass3 = r.r >= LARGE;
  if (r.kind === 'ui') { if (!pass3) fails++; }
  else { if (!passAA) fails++; if (passAA === false && pass3) largeOnly++; }
  console.log(
    pad(r.label,58) +
    pad(r.r.toFixed(2)+':1',9) +
    pad(passAA ? 'PASS' : 'FAIL',9) +
    pad(pass3 ? 'PASS' : 'FAIL',8) +
    r.note
  );
}
console.log('\n' + '='.repeat(104));
console.log(`TOTAL PAIRS: ${total}   FAILING their threshold: ${fails}   (of the AA failures, ${largeOnly} still clear 3:1 large-text/UI)`);
console.log('Thresholds: normal text AA = 4.5:1 (SC 1.4.3); large text (>=18.66px bold / 24px) & UI components = 3:1 (SC 1.4.11)');
console.log('Rows marked kind=ui are judged against 3:1 only (focus ring, borders, icon affordances).');
