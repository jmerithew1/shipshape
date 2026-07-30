# Audit Report — Ship (ShipShape)

**Repo:** `jamesmerithew/shipshape` (fork of `US-Department-of-the-Treasury/ship`)
**Audited at:** `076a183` · orientation notes `e782f94`, `425f8bc`, `535fe92`
**Date:** 2026-07-27
**Phase:** 1 of 2 — diagnosis. All measurements were taken at `076a183` (2026-07-27) with a clean
working tree, verified via `git status` after every measurement. **Within that measurement window,
nothing was fixed.** Eight non-documentation commits landed after this report's first draft and
before it was reconciled with them — see the
[Post-draft change log](#post-draft-change-log-added-2026-07-29) immediately below.

> **Companion documents:** [`REMEDIATION_PLAN.md`](REMEDIATION_PLAN.md) — root-cause synthesis,
> fix ordering, what is deliberately not being built, and the limits of this evidence.
> [`ORIENTATION.md`](ORIENTATION.md) — the mental model this audit was built
> on, completed *before* any measurement, with a traceability table for all 32 checklist questions.

---

## Post-draft change log (added 2026-07-29)

This report's first draft (`97c0fdc`, 2026-07-27 14:49) said "Nothing was fixed. No source file,
index, query, test, or Terraform config was modified." That was true of the measurement window — and
then stopped being true of the repository, and the report was not updated. Eight non-documentation
commits landed on 2026-07-28 between 10:56 and 20:56. Six of them predate this report's final
pre-review edit (20:17) by hours and should have been reconciled then; the last two landed minutes
after it. That is a process failure in a report whose core promise is that claims track evidence.
The table below reconciles every one.

Original baselines are **not** regenerated — they remain the audit-window record. Where a commit
invalidates a baseline for Phase-2 delta purposes, that is stated here, and Phase-2 comparisons use
fresh re-baselines captured at a single post-change HEAD (`bench/*/out/rebaseline-*`), never the
audit-window numbers.

| Commit | 07-28 | What changed | Report claims affected | Baselines invalidated |
| --- | --- | --- | --- | --- |
| `0706a13` | 10:56 | Measurement harnesses committed into [`bench/`](bench/README.md) (~22 files); corrections count 6→9 in this report | "Scratch harnesses live outside the repo" (Method notes) — corrected in place | None |
| `f07264a` | 11:00 | `.gitignore` +14; untracked 4 deploy zips, 6 terraform module locks, `web/dev-dist` | None — but it *implements the remedy* for the corrections-table `.gitignore` finding, which is a fix and out of bounds for Phase 1 | None |
| `ebd8f95` | 11:08 | Build tooling: cross-platform build scripts, new `api/scripts/copy-db-assets.mjs`, coverage provider installed, root `test` made recursive; `package.json` + lockfile changed | Cat 2 "lockfile verified unchanged"; Cat 2 "build fails on Windows"; Cat 5 "coverage is unmeasurable"; Cat 5 "root test is api-only" — each corrected in place below | Cat 5 test count (451 → 602) and coverage baseline; Cat 2 build path |
| `fe67e55` | 11:09 | `.gitignore` +4; removed the 87 coverage files `ebd8f95` swept in accidentally | None | None |
| `cc23a74` | 12:19 | New `terraform/local/` — hashicorp/local 2.5.2 drift demo with captured evidence | Cat 8 "both required providers are fully greenfield" — corrected in place | Cat 8 provider-gap grep results |
| `0fbe706` | 12:30 | New `terraform/render/` — render-oss/render 1.9.1 deployment config with captured evidence | Same Cat 8 claim | Same |
| `bba9801` | 20:51 | **Runtime code:** `api/src/app.ts` +36 lines (serve the built SPA from the API); `railway.json` | The header's "no source file was modified" — this commit landed 34 minutes *after* this report's last edit | Cat 1 counts over `api/`; Cat 3 latency comparability (new static-serving middleware sits in the request path) |
| `95277d0` | 20:56 | `package.json` postinstall hardened; `.railwayignore` | Header claim, as above | None |

Two ways to read this table, both true. The honest one: the diagnose/fix boundary held for the
measurements but not for the repository, and this report failed to say so for a day. The operational
one: every Phase-2 before/after comparison is anchored to fresh re-baselines at one post-change HEAD
precisely because these commits made the audit-window numbers non-comparable.

---

## Reproducibility conditions

Every number below was measured under these exact conditions. Comparisons in Phase 2 must reproduce them.

| | |
| --- | --- |
| Postgres | 16.14, Docker container `shipshape-postgres-1`, host port **5433**, db `ship_dev` |
| API | `http://localhost:3000` under `tsx watch` — **dev mode**, single Node process, no clustering |
| Web | `http://localhost:5173`, Vite 6.4.1 |
| Node / pnpm | v24.18.0 / 10.27.0 (corepack-pinned) |
| Terraform | v1.15.8 (`.terraform-version` pins 1.6.0; every `required_version` is `>= 1.6.0`) |
| **Seed volume** | **557 documents** · 254 issue · 127 wiki · 45 project · 35 sprint · 32 weekly_plan · 27 retro · 15 review · 11 person · 6 standup · 5 program · **23 users** · **551 associations** · 1 workspace |
| Data generation | `pnpm db:seed`, then a volume-extension script (below) to reach the required 500+ docs / 20+ users |

`pnpm db:seed` alone produces 257 documents and 11 users — **below the assignment's required audit
volume**, so latency and query measurements against it would understate real behaviour. The
top-up script adds 150 issues, 120 wiki pages (half nested), 30 ICE-scored projects and 12 users,
plus 150 project associations. It changes no application code and no schema.

**Dev-mode caveat.** The API runs unoptimised with live source maps and a single event loop.
Absolute latencies are pessimistic versus a production build; **relative rankings and the
saturation behaviour are the durable findings.**

---

## Measurement limits

What this evidence does **not** cover, stated so no one over-reads it. Moved here from
[`REMEDIATION_PLAN.md`](REMEDIATION_PLAN.md) §6 on 2026-07-29 — a limits table belongs in the report
that carries the numbers, not in a companion document. One row (real keyboard traversal) was missing
from the original table entirely and is added below. Rows marked ★ are being executed post-audit;
results land in [Post-audit measurement execution](#post-audit-measurement-execution-2026-07-2930)
at the end of this report.

| Not measured | Why |
| --- | --- |
| **E2E pass/fail/flaky/runtime** | 869 tests cannot start on this host (two defects, Cat 5). Deliberately not fixed during diagnosis — "unrunnable as shipped" is itself the finding, and its before-state is worth preserving. |
| **Dependency CVEs** | No `pnpm audit` run recorded. The repo's own `comply` toolchain has its SBOM path **disabled** (`--skip-trivy`, upstream ImportError), so vulnerability scanning has never actually run here. |
| **Production-mode performance** | All latency measured against a dev server (`tsx watch`, single process, no clustering). Absolute numbers are pessimistic; **relative rankings and the c=10 saturation are the durable findings**. |
| **Load beyond 50 connections** | Saturation was already reached at 10, so higher concurrency would only measure queue depth. |
| **Cross-browser / mobile** | Playwright is chromium-only by deliberate project choice; no viewport projects exist. |
| **Authenticated Lighthouse** | Lighthouse could not carry the session cookie into the SPA's XHR; only `/login` has a valid score. axe-core was used instead on authenticated pages. |
| **Real multi-user collaboration under load** | The Yjs split-brain risk at 10× is reasoned from the code (in-process Maps, no session stickiness, `MaxSize 4`), **not** observed — it cannot be reproduced on a single instance. |
| ★ **Concurrent two-user editing** | Not exercised with two simultaneous sessions. The CRDT-vs-last-write-wins split and the multi-instance split-brain risk are derived from the code paths (`collaboration/index.ts`, `documents.ts:484`), not observed. |
| ★ **3G / throttled-network behaviour** | Not throttled. The 15 silent failures were found via code paths and induced API failures rather than by degrading the connection, so hanging spinners under slow networks specifically remain unmeasured. |
| ★ **Screen-reader testing** | Not performed. The ~30 ARIA findings come from axe-core plus programmatic tab-order analysis; assistive-technology behaviour is not automatable and was out of reach here. This does not soften the measured findings — the 2.89:1 focus ring and 21 contrast violations stand on their own. |
| ★ **Real keyboard traversal** | Not performed in Phase 1 — **and, unlike the three rows above, this was never rolled up as a limit until 2026-07-29.** The automation harness could not deliver real keystrokes (verified — Tab did not move focus), so every keyboard result in Categories 6–7 is programmatic analysis of the tabbable set, stated as such in the category prose but easy to misread as observed traversal. |
| **Terraform plan against live AWS** | No credentials. `init -backend=false`, `validate`, `fmt` and `providers` all ran; blast-radius classification is static reasoning from provider ForceNew semantics and is labelled as such. |

---

## What this audit got wrong, and how it found out

Read this before the findings, because it is the only direct evidence that a *process* ran rather
than a list being asserted. **Nine claims did not survive verification** and were withdrawn or
corrected — full table at the end.

Three worth knowing up front:

- **I reported six e2e tests as empty. All six contain real assertions** — the *detector* has a
  body-termination bug. The corrected finding is worse than the original: the repo's only automated
  gate fails on every commit regardless of content. Recorded as its own commit, `425f8bc`.
- **I predicted migration `033` breaks fresh installs.** Running it showed the loop dies 23
  migrations earlier, at `010`, **silently, with exit code 0**. The conclusion held; the mechanism,
  location and blast radius were all wrong.
- **I ranked the unusable GIN index as the #1 optimisation target.** A second category then measured
  its actual cost at **0.34 ms** and it was demoted to a scaling landmine. Dramatic, but not today's
  bottleneck.

Every number below carries the command that produced it (see [`bench/`](bench/README.md)), so any of
this can be re-checked rather than taken on trust.

## Summary of findings

Eight categories measured. **41 distinct findings**, ranked below by consequence rather than by
category order.

| Rank | Finding | Cat | Severity |
| --- | --- | --- | --- |
| 1 | `db:migrate` applies **10 of 47** migrations and **exits 0** | — | 🔴 Critical |
| 2 | A transient API error **logs users out** and wipes cached auth | 6 | 🔴 Critical |
| 3 | An unhandled async rejection **exits the whole process** | 6 | 🔴 Critical |
| 4 | Unauthenticated, un-tenant-scoped program lookup | — | 🔴 Critical |
| 5 | Cross-tenant title/colour disclosure via unvalidated associations | — | 🔴 Critical |
| 6 | **No CI at all** — removed twice; `SECURITY.md` still claims it exists | 5 | 🔴 Critical |
| 7 | The **only** local gate fails on every commit (detector bug) | 5 | 🔴 Critical |
| 8 | Audit trail (incl. failed logins, impersonation) **fails silently** | 6 | 🔴 Critical |
| 9 | `/api/issues` **720 ms p50** at 50 users; server saturated at 10 | 3 | 🟠 High |
| 10 | One chunk is **92% of all JS**; 23 routes load eagerly | 2 | 🟠 High |
| 11 | Accessibility badges (**508 / WCAG 2.1 AA**) are unbacked; focus ring **2.89:1** | 7 | 🟠 High |
| 12 | **869 tests (59%) cannot start**; coverage unmeasurable | 5 | 🟠 High |
| 13 | Terraform: **aws 5.100.0 vs 6.28.0** depending on directory | 8 | 🟠 High |
| 14 | Committed plan file leaks **AWS account ID + IAM ARN + subnet IDs** | 8 | 🟠 High |
| 15 | `web/` hides **102 type errors** by not extending the root config | 1 | 🟠 High |

---

# Category 1 — Type Safety

### How it was measured

Counts were taken with the **TypeScript compiler API**, not grep — because grep cannot distinguish
`as const` from an unsafe assertion, SQL `AS` inside a template string from a TS `as`, or `x!` from
`!==`. Script: `scratchpad/count-types.mjs`, walking `api/src`, `web/src`, `shared/src` and counting
AST nodes (`AnyKeyword`, `isAsExpression`, `isNonNullExpression`, `isTypeAssertionExpression`).

```bash
node scratchpad/count-types.mjs C:/Users/merit/OneDrive/Desktop/shipshape

node_modules/.bin/tsc --noEmit -p api/tsconfig.json    2>&1 | grep -cE "error TS"
node_modules/.bin/tsc --noEmit -p web/tsconfig.json    2>&1 | grep -cE "error TS"
node_modules/.bin/tsc --noEmit --noUncheckedIndexedAccess --noImplicitReturns \
  --noFallthroughCasesInSwitch -p web/tsconfig.json    2>&1 | grep -cE "error TS"
```

**Why this matters:** naive grep reports **1,538** `as` and **2,051** `!`. The real figures are
**618** and **329**. Publishing the grep numbers in a pass/fail report would have been wrong by 2.5×
and 6×.

Excluded: `node_modules`, `dist`, `build`, `.git`, `coverage`, all `*.d.ts`, and one generated file
(`web/src/components/icons/uswds/types.ts`).

### Baseline

| Metric | Baseline |
| --- | --- |
| Total `any` types | **260** (production 83 · test 177) |
| Total type assertions (`as`, unsafe) | **618** (production 432 · test 186) — excludes 71 `as const` |
| Total non-null assertions (`!`) | **329** (production 325 · test 4) |
| Total `@ts-ignore` / `@ts-expect-error` | **0 / 1** |
| Strict mode enabled? | **Yes — all three packages** |
| Strict-mode error count | api **0** · shared **0** · web **0** as configured · **web 102** with the root's extra flags |
| Top 5 violation-dense files | see below |

Supplementary: `as const` **71** (safe) · double assertions `x as unknown as T` **9** ·
legacy `<T>x` **0** · `satisfies` **1**.

### Per package

| Package | Scope | Files | `any` | `as` | `!` | ts-ignore |
| --- | --- | --: | --: | --: | --: | --: |
| **api** | production | 78 | 54 | 135 | **292** | 0 |
| | test | 30 | 173 | 170 | 4 | 0 |
| **web** | production | 178 | 29 | **297** | 33 | 0 |
| | test | 18 | 4 | 16 | 0 | 1 |
| **shared** | production | 8 | **0** | **0** | **0** | **0** |

`shared/` is completely clean. The two problem shapes are opposite: api's is non-null assertions
(292), web's is type assertions (297).

### Strict mode per package — and the 102-error delta

| Package | Extends root? | `strict` | `noUncheckedIndexedAccess` | `noImplicitReturns` | `noFallthroughCasesInSwitch` |
| --- | --- | --- | --- | --- | --- |
| api | yes | ✅ | ✅ | ✅ | ✅ |
| shared | yes | ✅ | ✅ | ✅ | ✅ |
| **web** | **no** | ✅ | ❌ | ❌ | ❌ |

`web/tsconfig.json` has no `extends` key. Enabling the root's three extra flags surfaces
**102 errors**, attributed by running each alone: `noUncheckedIndexedAccess` **94**,
`noImplicitReturns` **8**, `noFallthroughCasesInSwitch` **0**. So every array index and record lookup
in the 46,882-LOC frontend is typed as definitely-present when it is not.

Densest under those flags: `CommandPalette.tsx` 13 · `lib/cn.ts` 12 · `hooks/useSelection.ts` 12 ·
`editor/CommentDisplay.tsx` 12 · `editor/AIScoringDisplay.tsx` 12. `cn.ts` and `useSelection.ts`
are shared utilities, so those propagate.

### Top 5 violation-dense files (production)

| # | File | `any` | `as` | `!` | Total | What the unsafe types hide |
| --- | --- | --: | --: | --: | --: | --- |
| 1 | `api/src/routes/weeks.ts` | 11 | 25 | 48 | **84** | 48 × `req.userId!` / `req.workspaceId!` — both **optional** on the augmented `Express.Request` (`middleware/auth.ts:11`). Plus `req.query.user_id as string`, where Express actually yields `string \| string[] \| ParsedQs` — a duplicated query param produces an array where a string is assumed, and it flows into SQL params. |
| 2 | `api/src/routes/projects.ts` | 15 | 10 | 26 | **51** | Same auth pattern, plus `const params: any[]` — erasing all checking between SQL text and bound values. |
| 3 | `api/src/routes/issues.ts` | 4 | 7 | 37 | **48** | Highest `!` density relative to `any`; risk concentrated entirely in the "auth definitely ran" assumption. |
| 4 | `web/src/pages/UnifiedDocumentPage.tsx` | 0 | 36 | 1 | **37** | 36 assertions simulating a discriminated union that was never declared. Nothing verifies the runtime object matches. |
| 5 | `api/src/db/seed.ts` | 0 | 0 | 35 | **35** | Real index suppressions — but a dev-only script. Listed for count honesty; **not** a priority. |

By *density* (per 100 LOC) the ranking is more diagnostic: `ProjectDetailsTab.tsx` 7.7 ·
`UnifiedDocumentPage.tsx` 6.9 · **`yjsConverter.ts` 6.9** · `WeekOverviewTab.tsx` 6.8.

### Findings

1. **236 `req.userId!` / `req.workspaceId!` assertions** across api routes. Both fields are optional
   on the augmented request, so every one encodes an unverified "auth middleware ran first"
   assumption. A route registered before `authMiddleware` sends `undefined` into SQL parameters —
   an auth-bypass shape, not a crash. An `AuthenticatedRequest` type narrowed once by the middleware
   deletes all 236.
2. **`api/src/utils/yjsConverter.ts` — 17 violations in 246 lines, on the hot persist path.** Every
   boundary function is untyped: `yjsToJson(...): any`, `jsonToYjs(..., content: any)`,
   `loadContentFromYjsState(...): any | null`. Worse, `element.setAttribute(key, value as string)`
   is a lie — `value` derives from an `any` and is genuinely `unknown` at runtime. A numeric or
   object attribute is asserted to string and **written into the CRDT, persisted, and replicated to
   every collaborating client.** The read path already knows this (it re-parses `level` back to a
   number); the write path asserts otherwise.
3. **`web` opting out of `noUncheckedIndexedAccess`** — 94 latent errors in shared utilities.
4. **Express query params asserted `as string`** at the trust boundary — attacker-reachable.
5. **No ESLint anywhere.** Verified three ways: no config file, `grep -c eslint pnpm-lock.yaml` → **0**
   (not even transitively installed), and no package defines a `lint` script. Root `pnpm lint`
   recurses into nothing and exits 0. Nothing enforces any count in this section.
6. **`e2e/` (76 files) is in no package's tsconfig** and is type-checked by nothing.

Notable absences: **zero** object-shape discriminated unions repo-wide; zero
`Pick`/`Omit`/`Exclude`/`Extract`/`NonNullable`; zero branded types (every ID is a bare `string`, and
`documentId`/`workspaceId`/`userId` are freely interchangeable).

---

# Category 2 — Bundle Size

### How it was measured

```bash
cd web && ./node_modules/.bin/tsc && VITE_API_URL= ./node_modules/.bin/vite build
node -e "<read dist/assets, zlib.gzipSync each, sum>"          # exact raw + gzip
VITE_API_URL= ./node_modules/.bin/vite build --sourcemap --outDir dist-sourcemap-tmp
node scratchpad/smattr.mjs dist-sourcemap-tmp/assets/index-*.js  # VLQ byte attribution
```

`source-map-explorer` could not read Vite 6's sourcemap (`refers to generated column Infinity`), so
byte attribution uses a dependency-free VLQ decoder measuring **post-minification** bytes.
`vite-bundle-visualizer` agreed on the ranking. **No devDependency was installed** — `npx --yes`
only touches the global npm cache; `package.json` and the lockfile were verified unchanged.

> **Correction (2026-07-29):** true at `076a183`. Superseded by `ebd8f95` (07-28), which
> deliberately changed `package.json` and the lockfile as Phase-2 build tooling — see the
> Post-draft change log.

**Finding surfaced by the method itself:** `cd web && pnpm build` **fails on Windows**. The script is
`tsc && VITE_API_URL= vite build`; pnpm spawns via `cmd.exe`, which rejects the POSIX inline-env
prefix. Pre-existing defect, not introduced here.

> **Update (2026-07-29):** fixed post-draft by `ebd8f95` (cross-platform build scripts, `cross-env`).
> The finding stands as the audit-window record.

### Baseline

| Metric | Baseline |
| --- | --- |
| Total production bundle size | **2,321.58 kB raw / 700.93 kB gzip** (JS + CSS + html) |
| Largest chunk | **`index-C2vAyoQ1.js` — 2,073.70 kB raw / 587.93 kB gzip — 92.1% of all JS** |
| Number of chunks | **262** = 1 main + 14 lazy feature + 1 shared + **245 per-icon** + 1 CSS |
| Top 3 largest dependencies | `emoji-picker-react` **266.7 kB** (12.9%) · `highlight.js` **170.6 kB** (8.2%) · `react-dom` **132.2 kB** (6.4%) |
| Unused dependencies | **1** — `@tanstack/query-sync-storage-persister` |

Initial-load subset (html + CSS + main chunk): **2,144.83 kB raw / 601.93 kB gzip**.
CSS is a single 66.51 kB / 12.83 kB gzip file — reasonable, not a lever.

### What is inside the main chunk

| Rank | Package / area | Raw kB | % of chunk |
| --: | --- | --: | --: |
| 1 | `app:src/components` | 344.1 | 16.6% |
| 2 | **`emoji-picker-react`** | **266.7** | 12.9% |
| 3 | `app:src/pages` | 229.8 | 11.1% |
| 4 | **`highlight.js`** (37 languages) | **170.6** | 8.2% |
| 5 | `react-dom` | 132.2 | 6.4% |
| 6 | `prosemirror-view` | 96.3 | 4.6% |
| 7 | `yjs` | 67.3 | 3.2% |
| 8 | `@tiptap/core` | 66.3 | 3.2% |

Rolled up: **editor stack ≈ 692.6 kB** (ProseMirror 233.7 + highlight.js 170.6 + TipTap 118.2 +
Yjs 116.0 + Popper/Tippy/linkify 54.1). Adding `emoji-picker-react` and `diff-match-patch` gives
**≈ 978 kB — 47.2% of the main chunk — all of it deferrable.**

### Code splitting: present, but aimed at the wrong layer

- **13 `React.lazy` calls**, all in one file (`web/src/lib/document-tabs.tsx:52-66`), totalling only
  **71.8 kB — 3.2%** of the bundle.
- **23 page components, every one statically imported** (`web/src/main.tsx:19-43`); 40 `<Route>`
  elements. **Zero routes are lazy.**
- **2 dynamic `import()` calls exist and are both defeated** — Rollup warns that
  `src/services/upload.ts` *"is dynamically imported … but also statically imported … dynamic import
  will not move module into another chunk."* Someone already tried to split these and a static
  import elsewhere silently cancelled it.

The eager chain is why the editor ships on `/login`: `main.tsx` → `UnifiedDocumentPage` →
`UnifiedEditor` → `Editor.tsx` → TipTap + ProseMirror + lowlight + Yjs + Tippy.

### Unused dependencies — evidence, not guesses

**Confirmed unused (1):** `@tanstack/query-sync-storage-persister`. Zero references repo-wide
outside its own `package.json` line; not a Vite plugin, not a CSS import, not a dynamic import;
**absent from every sourcemap `sources` entry**. The app rolls its own `createIDBPersister()` on
`idb-keyval` instead. Removing it saves **0 bytes** — hygiene only, and it must not be counted toward
a size target.

**Cleared as false positives** (checked individually, 43 of 44 dependencies are genuinely used):

| Package | Why it looked unused | Why it isn't |
| --- | --- | --- |
| `@uswds/uswds` | zero import statements | consumed via `import.meta.glob(...'?react')` in `Icon.tsx:23` — this one line generates all 245 icon chunks |
| `@tanstack/react-query-devtools` | dev tool in `dependencies` | imported in `main.tsx:6`; resolves to a 0.03 kB no-op stub in production |

**Dismissed red herring.** The bundle contains `react-router/dist/**development**/chunk-*.mjs`
(37.0 kB), which looks like free savings. It is not: `react-router@7.12.0`'s `exports` map has **no
`production` condition**, and `diff` between the development and production builds shows **exactly
one differing line** (`ENABLE_DEV_WARNINGS = true` vs `false`). Aliasing would recover low single-digit
kB, not 37. Flagged so nobody burns a day on it.

### Ranked reduction opportunities

Target for reference: 15% of the main chunk = **311 kB raw / 88 kB gzip**.

| # | Opportunity | Est. raw | Est. gzip | % of target | Risk |
| --: | --- | --: | --: | --: | --- |
| 1 | `React.lazy` the 23 eager routes — especially `UnifiedDocumentPage` and `PersonEditor`, which drag in the whole editor stack | **~700–900 kB** | **~200–255 kB** | **225–290%** | Low; mechanical + `<Suspense>` |
| 2 | Lazy-load `EmojiPickerPopover` — one import site, a click-triggered popover | **266.7 kB** | **~75.7 kB** | **~86%** | Very low |
| 3 | Replace lowlight's `common` preset (37 languages incl. arduino, kotlin, vbnet, wasm) with ~8 realistic ones | ~130–145 kB | ~37–41 kB | ~42–47% | Low |
| 4 | Remove the static imports defeating the 2 existing dynamic imports | ~10–25 kB | ~3–7 kB | ~8% | Low |
| 5 | Lazy `diff-match-patch` behind `DiffViewer` | 19.1 kB | ~5.4 kB | ~6% | Very low |
| 6 | `manualChunks` vendor split | **0 net** | **0 net** | **0%** | improves caching only — must not be counted |

**Items 2 + 3 alone — two files, no routing changes — yield ≈ 400 kB raw / 113 kB gzip ≈ 19%**,
clearing the target. Item 1 is the structurally correct fix and overshoots by ~3×.

### Additional observation

The **245-icon architecture** produces 245 separate chunks averaging 428 bytes. That is not a size
problem but a **request-waterfall** problem: a page showing 30 icons fires 30 requests, each with an
empty-`<span>` fallback. `Icon.tsx` is itself the 11th-largest source in the bundle at 28.1 kB,
because the full 245-member `ICON_NAMES` array ships at runtime for validation.

No date or i18n library exists anywhere (`moment`, `date-fns`, `dayjs`, `luxon`, `i18next` — all
absent). The usual bloat source is genuinely not present here; the weight is editor + emoji.

---

# Category 3 — API Response Time

### How it was measured

Two blockers had to be solved before any number was trustworthy. **Both are findings, not artifacts.**

1. **A global rate limiter caps the API at 1000 req/60 s per IP** (`api/src/app.ts:81-88`). A naive
   `autocannon -d 10 -c 25` issues ~8000 requests and **benchmarks HTTP 429s**. The first matrix did
   exactly that: 700/700 non-2xx.
2. **Sessions expire 15 minutes after creation regardless of activity** — `expires_at` is never
   extended, only `last_activity` (`middleware/auth.ts:205`). The session died mid-run, producing
   401s indistinguishable from rate-limiting in raw counts.

Every cell below is sized to fit inside one verified-fresh rate-limit window (300 samples + 30
warm-up), with re-authentication immediately before each run. **Status distribution: 300 × HTTP 200,
zero non-2xx, on every cell.**

```bash
bash go.sh issues       "/api/issues"                        10 300 30   # repeat 25, 50
bash go.sh projects     "/api/projects"                      10 300 30
bash go.sh action-items "/api/accountability/action-items"    10 300 30
bash go.sh my-week      "/api/dashboard/my-week"              10 300 30
bash go.sh ctl-auth-me  "/api/auth/me"                        10 300 30
bash baseline.sh    # c=1 uncontended, all five, one window
node rtt.js         # Node → Postgres round-trip cost
```

Postgres statement logging was **disabled before benchmarking** and re-verified off afterwards.
A custom closed-loop Node generator was used rather than autocannon for the recorded figures, because
autocannon v8 reports p90 and p97.5 but **has no p95**, and TTFB-vs-total was needed to separate
serialisation from query time. autocannon was used to validate the approach and agreed.

### Baseline — P50 / P95 / P99 (ms)

| Endpoint | c=10 P50 | P95 | P99 | c=25 P50 | P95 | P99 | c=50 P50 | P95 | P99 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| `GET /api/issues` (223 kB) | **141.9** | 181.7 | 193.1 | **398.8** | 530.4 | 576.4 | **720.3** | 846.5 | 945.1 |
| `GET /api/accountability/action-items` (0.5 kB) | **112.1** | 211.0 | 296.0 | **254.6** | 356.9 | 500.0 | **514.1** | 644.4 | 708.9 |
| `GET /api/projects` (31.8 kB) | **58.3** | 120.7 | 157.7 | **208.0** | 351.3 | 435.7 | **543.5** | 747.6 | 883.8 |
| `GET /api/dashboard/my-week` (1.2 kB) | **54.4** | 153.4 | 226.9 | **201.2** | 335.0 | 433.2 | **376.9** | 629.6 | 794.6 |
| `GET /api/auth/me` — *control / floor* (0.4 kB) | **21.9** | 83.3 | 114.0 | **129.4** | 226.5 | 306.7 | **161.4** | 235.0 | 301.7 |

| Endpoint | rps c=10 | c=25 | c=50 | **c=1 P50** | SQL queries/req |
| --- | --: | --: | --: | --: | --: |
| `/api/issues` | 71 | 60 | 66 | 21.4 ms | 5 |
| `/api/accountability/action-items` | 81 | 93 | 93 | 26.5 ms | **14** (33 cold) |
| `/api/projects` | 153 | **108** | **86** | 16.4 ms | 9 |
| `/api/dashboard/my-week` | 149 | 111 | 118 | 17.0 ms | 9 |
| `/api/auth/me` | 323 | 179 | 275 | 10.1 ms | 5 |

p50 and p95 are solid at 300 samples; **treat p99 as indicative** (3rd-slowest of 300).

### Why these five endpoints

Traced from the actual app shell (`web/src/pages/App.tsx`), not guessed. `/api/issues`,
`/api/projects` and `/api/accountability/action-items` are mounted in the shell and fire on **every
authenticated route**; action-items additionally runs a **60-second refetch loop**, making it the
highest-volume endpoint in the system. `/api/dashboard/my-week` is the landing dashboard.
`/api/auth/me` is a deliberate **control** isolating the auth + framework floor.

**Two candidates were excluded, and that exclusion is itself a finding:**
`/api/team/accountability-grid-v2` (**394 kB, 76 ms — the largest and slowest endpoint in the API**)
and `/api/dashboard/my-work` have **zero references anywhere in `web/src`**. Dead API surface.

### The server is already saturated at 10 connections

Throughput is flat or **falling** from c=10 onward while latency rises linearly. Little's Law
(W = C/λ) closes almost exactly for `/api/issues`: 10/71 = 141 ms (measured 141.9), 25/60 = 417 ms
(measured 398.8), 50/66 = 758 ms (measured 720.3). **100% of added latency beyond c=10 is queue wait,
not work.** The inflection point is at or below the lowest level tested.

`/api/projects` is worse — **negative scaling**: 153 → 108 → 86 rps, a **44% throughput loss** from
10 to 50 connections.

Root cause is structural: one Node process, one event loop, no clustering. JSON serialisation and
per-request query fan-out all serialise onto one thread.

### Payload vs. query time — separated

TTFB ≈ total (delta < 0.5 ms even for the 223 kB response), so loopback transfer is free and all cost
is server-side. A **Node → Postgres round trip costs 1.86 ms p50** (measured directly), while the SQL
itself executes in 0.1–3.7 ms — per-query cost is almost pure round-trip overhead.

- **`action-items` is 100% query-count-bound.** 14 warm queries × 1.9 ms ≈ 26.6 ms predicted vs
  **26.5 ms measured** at c=1 — for a **483-byte** response. It is *slower than `/api/projects`,
  which returns 65× more data.* Worst latency-per-byte in the system, on a 60 s loop, on every route.
- **`/api/issues` is payload-bound.** Only 5 queries (~9.5 ms) yet 21.4 ms total → **~12 ms is JSON
  serialisation** of 223 kB, because the list query selects `d.content` — full document bodies for all
  254 issues (`api/src/routes/issues.ts:125`).
- **The auth tax is the floor under everything:** 10.1 ms at c=1, **38–61% of every endpoint's
  latency** before any real work.

### Ranked latency targets

1. **`/api/issues` payload** — stop selecting `d.content` in the list view; paginate. Removes ~12 ms
   of serialisation from the critical path of every route.
2. **`action-items` query fan-out** — 14 round trips for 483 bytes, every 60 s, every route. Highest
   aggregate load contributor in the system.
3. **The auth tax** — `UPDATE sessions SET last_activity` is the most-executed statement in the API
   and blocks every request. Throttling it (as the cookie refresh already is) removes ~2 ms from 100%
   of traffic.
4. **`/api/projects` correlated subplans** — the only endpoint with negative throughput scaling.
5. **Single Node process** — the hard ceiling behind c=10 saturation.
6. **The 1000 req/min limiter** — at 16.7 rps sustained it binds well below measured capacity
   (60–323 rps); any real burst hits it first.

---

# Category 4 — Database Query Efficiency

### How it was measured

```sql
ALTER SYSTEM SET log_statement = 'all';
ALTER SYSTEM SET log_min_duration_statement = 0;
SELECT pg_reload_conf();
```

Logs read via `docker logs shipshape-postgres-1`. Each flow was bracketed with marker statements,
exercised through the real API with a session cookie, then counted between markers
(`scratchpad/parse.py`, `run_flow.sh`). `SET enable_seqscan=off` was used only inside throwaway psql
sessions, never `ALTER SYSTEM`.

TanStack Query's cache was bypassed, so every flow is measured as a **cold load** — worst case.

**Scale caveat stated honestly:** `documents` is 720 kB total (320 kB heap / 40 pages) and sits
entirely in `shared_buffers`, so every "sequential scan" below is a warm memory scan. **Absolute
milliseconds are floor values; the query *shapes* are what scale.**

### Baseline

| User Flow | Total Queries | Slowest Query | N+1 Detected? |
| --- | --: | --: | --- |
| Load main page (`/my-week`, cold) | **57** | **6.43 ms** — `GET /api/projects` | **Yes** |
| View a document (`/documents/:id`) | **16** *(+48 shell = 64 cold)* | 2.49 ms | No |
| List issues (`/issues`) | **13** *(+48 = 61)* | 5.56 ms | No |
| Load sprint board (week Issues tab) | **19** *(+48 = 67)* | 3.32 ms | **Yes (in-plan)** |
| Search content (Cmd-K + `@`-mention) | **9** *(+48 = 57)* | 3.52 ms | No |

Counts are **exactly reproducible** — two independent runs produced 57 / 16 / 13 / 19 / 9 both times.

**"+48 shell"** = the app shell fires **9 unconditional API calls on every authenticated route**
(`useAuth`, four context providers, standup status, action items, session check, archived persons).
A cold load of any page pays that 48-query tax before the page's own queries.

There is **no `/sprints` board route** — `web/src/main.tsx:227` redirects it; the kanban board is the
Issues tab of a week document.

### The single largest cost: authentication

**Every request pays a fixed 3-query auth tax** — `SELECT … FROM sessions JOIN users`,
`UPDATE sessions SET last_activity`, `SELECT role FROM workspace_memberships`. On the main page that
is **30 of 57 queries — 53% of the flow — including 10 writes to `sessions` per page load.**

### N+1 findings

**CONFIRMED — `api/src/services/accountability.ts`, worse than expected.**
`GET /api/accountability/action-items` fires **14 queries for a 483-byte response**. The named site
(`:175-197`) issues 1 query at `:176` and a second at `:189` per active sprint — but it is one of
**five** such loops on the same request path:

| Loop | Per-row query | Multiplier |
| --- | --- | --- |
| `:175` | `:176` standup-today, `:189` `MAX(created_at)` | 2 × active sprints |
| `:262` | `:297` `COUNT(*)` issues in sprint | 1 × owned sprints |
| `:374` | `:381` weekly_plan, `:411` weekly_retro | 2 × allocations |

Measured cardinality: the dev user has 6 sprints with assigned issues and 4 owned. Query count is
**linear in sprints-per-user** and grows unbounded as sprint history accumulates — on a **60-second
refetch loop, per open tab.**

**CONFIRMED — `api/src/routes/issues.ts:640-647`.** One `COUNT(*)` per sprint association, issued
**after `COMMIT`** on a fresh pool connection, purely to decide whether to emit a websocket
celebration. Bounded and small in practice, so least severe of the confirmed set — but it is a serial
round trip added to create-issue latency. Not exercised at runtime deliberately: `POST /api/issues`
writes a row and would have shifted the baseline other measurements depend on.

**CONFIRMED — in-plan N+1, invisible to statement counting.** Three list endpoints issue *one* SQL
statement while the planner executes correlated subplans once per row:

| Endpoint | Buffer hits | Rows returned |
| --- | --: | --: |
| `/api/projects` | **2,328** | 45 |
| `/api/programs` | 969 | 5 |
| `/api/programs/:id/sprints` | 606 | 7 |

`/api/projects` shows `SubPlan 3` re-scanning all 35 sprints for every project
(`Rows Removed by Filter: 34`, `loops=45`), `Memoize … Hits: 0 Misses: 289` (the memoise node is
useless here), and **planning time 5.687 ms exceeding execution time 4.982 ms**.

**REFUTED — `/api/issues` is *not* N+1.** It correctly batches associations with
`document_id = ANY($1)` via `getBelongsToAssociationsBatch`. 13 queries for 3 endpoints regardless of
the 254 issues returned. **This is the right pattern and the one the other endpoints should copy.**

### Index gaps — all four hypotheses tested

**1. The GIN index on `properties` cannot serve `->>` predicates — CONFIRMED definitively.**
`idx_documents_properties` is `gin (properties)` with default `jsonb_ops`. Every hot issue filter
uses `->>` text extraction. All seq-scan. Because a seq scan on a 40-page table could merely be the
planner's preference, the issue was **forced**:

```
FORCED (enable_seqscan=off):  properties->>'state' = 'in_progress'
  Seq Scan on documents  (actual rows=33)
  Execution Time: 136.666 ms      <- planner ate the penalty rather than use the GIN index

CONTROL:                       properties @> '{"state":"in_progress"}'
  Bitmap Index Scan on idx_documents_properties  (actual rows=33)
  Execution Time: 0.107 ms
```

**A 1,000× gap.** The index is highly effective for `@>` containment and *completely inert* for
`->>`, and the application uses `->>` **exclusively** (200+ occurrences across route files). The one
thing the index can do, nothing asks it to do. The codebase already knows the fix pattern —
`idx_documents_person_user_id` is a btree on the *expression* `(properties->>'user_id')` and is being
used (49 scans).

**2. `api_tokens.token_hash` unindexed — CONFIRMED.** It is the sole lookup key on every
Bearer-authenticated request (`middleware/auth.ts:33-39`); the indexed `token_prefix` is never used
in a WHERE clause. **Latent, not currently firing** — the table has 0 rows, so the seq scan is free
today and invisible in any benchmark. It becomes a full scan per request the moment tokens exist,
plus an unconditional `UPDATE api_tokens SET last_used_at` on every call.

**3. `documents.ticket_number` unindexed — CONFIRMED.** `MAX(ticket_number)` full-scans `documents`
to compute one integer, at **four call sites**, inside `pg_advisory_xact_lock`-held transactions — so
the scan duration *is* lock hold time and directly gates concurrent issue creation.

**4. No trigram index for search — CONFIRMED.** `pg_trgm` is not installed and `title` has no index;
`search.ts:41,55,132` use leading-wildcard `ILIKE`, unindexable without trigram. **This fires per
keystroke** while `@`-mentioning. Separately, the Cmd-K palette does not search server-side at all —
it pulls **all 557 documents (307 kB) into the browser** and filters client-side.

### Index inventory: 13 on `documents`, 6 used, 7 never scanned

`pg_stat_user_indexes` (counters include the audit's own traffic, so real usage is if anything lower):

| Index | `idx_scan` | Verdict |
| --- | --: | --- |
| `documents_pkey` | 3463 | hot |
| `idx_documents_document_type` | 378 | hot — carrying nearly every list query |
| `idx_documents_person_user_id` | 49 | used (the correct expression-index pattern) |
| `idx_documents_parent_id` | 30 | used |
| `idx_documents_active` | 1 | effectively unused |
| `idx_documents_properties` | 1 | **that one scan was the forced `@>` control** — zero application use |
| `idx_documents_workspace_id` | **0** | dead — single-workspace data gives no selectivity |
| `idx_documents_visibility` | **0** | dead |
| `idx_documents_visibility_created_by` | **0** | dead |
| `idx_documents_archived_at` | **0** | dead |
| `idx_documents_deleted_at` | **0** | dead |
| `idx_documents_converted_from` | **0** | dead |
| `idx_documents_converted_to` | **0** | dead |

**352 kB of indexes on a 320 kB table, more than half never touched** — all maintained on every write.
`users` shows `seq_scan=179 / seq_tup_read=3896` on 23 rows, repeatedly hash-joined in full because
join keys are `(properties->>'…')::uuid` casts.

### Ranked optimisation targets

1. `->>` predicates cannot use the only JSONB index that exists — highest confidence, sits under the
   hottest list in the product.
2. The 3-query auth tax including a write, on every request.
3. App-shell fan-out: 9 unconditional calls = 48 queries before any page renders.
4. `action-items` — 14 queries for 483 bytes on a 60 s loop, with five nested loops.
5. Correlated subplans in `/api/projects`, `/api/programs`, `/api/programs/:id/sprints`.
6. Payload size — `/api/issues` 228 kB, `/api/documents` 307 kB.
7. `MAX(ticket_number)` seq scan held under an advisory lock.
8. `api_tokens.token_hash` — low measured impact, high latent risk.
9. No trigram index for `ILIKE` — rate-limited by human typing.
10. Seven never-scanned indexes — pure write amplification.

> **Cross-category correction.** Items 1 and 5 are the *mechanically* worst findings but cost
> **0.34 ms** and **3.7 ms** respectively at current volume (Category 3 measured this). They are
> **scaling landmines, not today's bottleneck.** Today's bottleneck is round-trip count and JSON
> serialisation. Both readings are correct; conflating them would misrank the fix list.

---

# Category 5 — Test Coverage and Quality

### How it was measured

Authoritative count via Playwright's own lister, which **enumerates without executing**:

```bash
npx playwright test --list --reporter=json     # 71 files, 869 test entries, errors: []
```

Vitest suites were run per package. **The api suite was run against a throwaway `ship_test`
database**, because `api/src/test/setup.ts:14-19` runs `TRUNCATE … CASCADE` over 15 tables
unconditionally against whatever `DATABASE_URL` resolves to — and `api/.env.local` points at
`ship_dev`. `ship_dev` row counts were verified identical before and after.

**The full Playwright suite was deliberately not run.** `playwright.config.ts:15-17` documents a
prior **90 GB memory explosion and system crash**, and the config's worker calculation on this
machine yields **8 workers** — the same count named in that history.

### Baseline

| Metric | Baseline |
| --- | --- |
| Total tests | **1,471** = 869 E2E + 451 api + 151 web |
| Pass / Fail / Flaky | api **451 / 0 / 0** · web **138 / 13 / 0** · E2E **not measured** |
| Suite runtime | api **61 s** · web **13 s** · E2E not measured — **74 s for 602 of 1,471 tests (41%)** |
| Critical flows with zero coverage | 14 of 28 API route modules + 6 UI routes — listed below |
| Code coverage % | **web: unmeasurable · api: unmeasurable** |

### Resolving the test-count dispute

Three earlier numbers were all correct measurements of *different things*:

| Method | Count | What it counts |
| --- | --: | --- |
| `grep -E "^\s*test\("` | 866 | `test()` declarations in source |
| `grep -E "\btest\("` | 882 | 866 + **16 false positives** — every one is `/regex/.test(...)` |
| `playwright --list` | **869** | **runtime test cases — authoritative** |

866 → 869: one `test()` sits inside a `for` loop over 4 endpoints
(`critical-blockers.spec.ts:143`). `866 − 1 + 4 = 869`. Fully reconciled.
Also: **252 `describe` blocks**, and **zero** `test.skip` / `.only` / `.fixme` anywhere.

### Coverage is unmeasurable, not merely unmeasured

`api/vitest.config.ts:12-16` declares `coverage: { provider: 'v8' }` and exposes `test:coverage`, but
**`@vitest/coverage-v8` has 0 hits in `pnpm-lock.yaml`** — the run aborts with
`MISSING DEPENDENCY`. `web/vitest.config.ts` declares no coverage block at all. No thresholds exist
anywhere, and Playwright collects none. **The honest baseline is that no coverage number exists today.**

> **Correction (2026-07-29):** true at `076a183`. `ebd8f95` (07-28) installed the coverage provider,
> so coverage is now *measurable*; the audit-window baseline remains "no number existed". See the
> Post-draft change log.

### The orphaned suite and its 13 invisible failures

Root `package.json:27` is `"test": "pnpm --filter @ship/api test"` — **api only**. `web` defines a
`test` script that nothing invokes, so 151 tests never run in any aggregate command, hiding:

| File | Failing |
| --- | --: |
| `web/src/lib/document-tabs.test.ts` | **9 / 22** |
| `web/src/components/editor/DetailsExtension.test.ts` | 3 / 10 |
| `web/src/hooks/useSessionTimeout.test.ts` | 1 / 34 |

Contrast: `build`, `type-check` and `lint` all use `--recursive`. Only `test` does not.

> **Correction (2026-07-29):** `ebd8f95` (07-28) made root `test` recursive, so the 13 failures are
> no longer invisible — they now fail the aggregate run. Fixing them is the first Phase-2
> workstream. See the Post-draft change log.

### E2E does not run on this host — two repo defects

1. **`web/package.json` build script** is `tsc && VITE_API_URL= vite build` — POSIX inline-env syntax.
   pnpm spawns via `cmd.exe`, so `globalSetup` dies with `'VITE_API_URL' is not recognized`.
   **The suite aborts before a single test starts.**
2. **`e2e/fixtures/isolated-env.ts:231`** calls `spawn('npx', [...])` without `shell: true`. On
   Windows the executable is `npx.cmd`; a bare `npx` is a shell script `CreateProcess` cannot run.
   Every worker fails `spawn npx ENOENT`. Verified directly: `spawnSync('npx', …)` → `ENOENT`.
   Note this is **not** fixable by using a POSIX shell — Node's `spawn` does not consult the
   launching shell.

One spec was run to confirm the diagnosis (`auth.spec.ts`, `--workers=1`): 202 s, 0 passed, 7 failed,
all in fixture setup. **That is fixture-timeout time, not execution time, and is not a valid basis
for extrapolating suite runtime** — hence "not measured" rather than an estimate.

### Flake and quality signals

| Signal | Measured |
| --- | --- |
| `waitForTimeout` calls | **619** across **49 of 71** files = **440,350 ms (7 m 20 s) of hard-coded sleep** |
| `waitForLoadState('networkidle')` | **175** across 35 files (60 in `accessibility-remediation.spec.ts` alone) |
| `retries: 1` **locally** | `playwright.config.ts:60`, commented *"for flaky WebSocket/timing tests"* — a written admission |
| `toPass()` retry wrappers | only **13** — the sanctioned mechanism is barely used against 619 sleeps |
| `login()` duplication | **39 spec files** define their own; no `storageState`, no auth setup project |
| Per-test DB isolation | **none** — isolation is per *worker*; no `afterEach`, no rollback, with `fullyParallel: true` |

Worst offenders: `tables.spec.ts` 52 · `file-attachments.spec.ts` 37 · `features-real.spec.ts` 36 ·
`backlinks.spec.ts` 34 (4.3 per test) · `drag-handle.spec.ts` 33 · `data-integrity.spec.ts` 33.

With ~869 tests each performing a full browser login, **`storageState` is the single highest-leverage
speedup available and is entirely absent.**

### The only automated gate fails on every commit

`scripts/check-empty-tests.sh` terminates a test body at the first line matching `/^\s*}\);/` — which
matches the close of **any indented nested callback** (`page.route`, `page.on`, `page.evaluate`). Six
tests are falsely flagged; **all six contain real `expect()` assertions** (verified by reading them
and by an independent brace-matched parse showing **0** assertion-free bodies repo-wide).

The hook runs under `set -e` and **exits 1 today** — confirmed. With no CI, it is the repo's only
automated gate, so it is routinely bypassed with `--no-verify`. That is precisely what commit
`ac06480` ("prevent `--no-verify` bypasses") was written to stop and `ac0c8ee` reverted.
**Effective automated quality enforcement is zero.**

### Zero-coverage flows

**Offline/PWA was deleted, not fixed.** `git log --diff-filter=D` shows **36 offline spec files**
removed across two commits (`3f5ec31`, `f1d727f`) — **143 tests, 5,658 lines**. `test-failures.md`
still lists offline failures as open work against specs that no longer exist, while the offline
machinery (`idb-keyval`, `y-indexeddb`) still ships in production.

| Flow | Coverage |
| --- | --- |
| Org chart (`/team/org-chart`) | **0 specs** |
| Converted documents (`/settings/conversions`) | **0 specs** |
| Person editor (`/team/:id`) | **0 specs** |
| Invite **acceptance** | negative paths only — **no test ever accepts a valid invite** |
| Public feedback form (unauthenticated) | not exercised as the public form |
| **Concurrent multi-user Yjs convergence** | **0** — the one test that did was deleted. `collaboration.test.ts:144` merges two `Y.Doc`s in-process, which proves the CRDT library works, not this server's protocol |

**14 of 28 API route modules have no test file — 9,997 LOC and 76 endpoints, ~54% of route modules:**
`team.ts` (13 endpoints, 2,195 LOC), **`admin.ts` (23 endpoints, 1,802 LOC)**, `weekly-plans.ts`,
`programs.ts`, `dashboard.ts`, `admin-credentials.ts`, `claude.ts`, `caia-auth.ts`, `associations.ts`,
`invites.ts`, `comments.ts`, `feedback.ts`, `setup.ts`, `ai.ts`.

### Top 3 test-improvement targets, ranked by risk carried

1. **The authorization surface** — `admin.ts` + `admin-credentials.ts` + `invites.ts` +
   `caia-auth.ts`: **33 endpoints, 3,261 LOC, zero tests.** These are the endpoints that *grant*
   access. A regression is silent privilege escalation, and nothing would catch it.
2. **Multi-user Yjs convergence through the real WebSocket server** — the product's core
   differentiator, where the failure mode is silent data loss.
3. **Make the suite executable and gated before writing any new test.** 869 tests — 59% of the
   suite — produce zero signal today. Fixing three small things (the build script, the `spawn` call,
   the detector regex) converts them into a working gate — better return than authoring any new test
   into a suite nobody can run.

---

# Category 6 — Runtime Error and Edge-Case Handling

### How it was measured

Browser automation against the running app (13:38–14:07 CDT). Nine routes exercised with the console
open; malformed input submitted via `curl` with a valid session + CSRF token; network failure
simulated by blocking `fetch`, terminating WebSockets, flipping `navigator.onLine` and dispatching
`offline`; server output inspected throughout.

**Two environment caveats, flagged rather than laundered into findings:** the concurrent load test
intermittently drove `/api/*` to HTTP 429, and the automation harness could not deliver real
keystrokes to the page (verified — Tab did not move focus). Keyboard results in Category 7 are
therefore programmatic, and stated as such.

**One false positive caught and discarded:** Escape appeared not to dismiss a modal. A dispatched
`KeyboardEvent` *did* close it and `ActionItemsModal.tsx:171` wires `onEscapeKeyDown` correctly —
the tool wasn't delivering the key. Similarly, `Error fetching backlinks` traced to the audit's own
`fetch` stub, not to app behaviour.

### Baseline

| Metric | Baseline |
| --- | --- |
| Console errors during normal usage | **0 errors, 0 warnings** across 9 routes + search + tab toggles. Under API failure: **3 distinct errors, all console-only with zero UI indication** |
| Unhandled promise rejections (server) | **0 observed** — but **0 handlers exist** and 4 uncovered `await` sites, any of which crashes the process |
| Network disconnect recovery | **Pass** — verified end-to-end including server-side merge |
| Missing error boundaries | Root, all 6 non-AppLayout routes, the entire AppLayout shell, all context providers |
| Silent failures identified | **15 ranked** (~13 sites in `api/src`, ~78 in `web/src`) |

**The zero is real but shallow.** When the API *was* failing, three errors fired and the page rendered
completely normally — no banner, no degraded state. The console is clean because the app is quiet,
not because it is resilient.

### The highest-impact bug: a transient API error logs users out

`web/src/hooks/useAuth.tsx:105-110` treats **any** non-success response as session expiry:

```js
} else {
  if (navigator.onLine) { clearCachedAuthData(); }   // 429 and 5xx land here
}
```

`user` stays `null` → `ProtectedRoute.tsx:21` redirects to `/login`, cached offline auth wiped, no
explanation shown.

**Proven spurious:** after being ejected to `/login`, a single reload once the API recovered logged
straight back in **without re-entering credentials**. The session cookie was valid the entire time.
The app cannot distinguish "server hiccup" from "logged out" and destroys local state on the guess.
The *offline* path is handled correctly (falls back to cached auth) — only the online-error path is wrong.

**Reproduction:** while `/api/auth/me` returns 429 or 5xx, navigate anywhere.

### Malformed input

Zod validation is genuinely good. Two gaps and one leak:

| Input | Result |
| --- | --- |
| `{}` (no title) | 201 — silently defaults to "Untitled" |
| `""` / 10 k chars / 256 chars | **400, clean, with field detail** (boundary correct at 255) |
| Wrong type / bad enum | **400, clean** |
| `<script>alert(document.cookie)</script>` | 201, stored verbatim — **renders escaped**; React escaping holds |
| `'; DROP TABLE documents;--` | 201, stored safely — parameterised queries work |
| **NULL byte (`\u0000`) in title** | **500 `{"error":"Internal server error"}`** — Zod passes it, Postgres rejects it, no actionable message |
| **200 kB `content` blob** | **201 accepted** — `content: z.any()` and `properties: z.record(z.unknown())` are **completely unbounded**; the only ceiling is `express.json({limit:'10mb'})` |
| **Truncated JSON** | **400 with an HTML stack trace leaking absolute server paths** — `SyntaxError: Unterminated string … at parse (C:\…` |

That last one is the missing error handler made concrete: body-parser errors fall through to
Express's `finalhandler`, which in non-production emits the stack as HTML.

### Server-side gaps

- **No global Express error handler** — confirmed absent by exhaustive grep of the single mount point.
  Also **zero `next(err)` calls anywhere**, so adding one would catch only framework errors today.
- **No request logging** — no morgan/pino/winston in source or dependencies. **No access log at all**:
  you cannot answer "which endpoint 500'd" or "what did this user do".
- **No `unhandledRejection` / `uncaughtException` handlers.** On **Node v24.18.0 + Express 4.22.1** an
  async rejection does not hang — Express 4 doesn't await handlers, so the rejection is unobserved and
  Node's default `--unhandled-rejections=throw` **exits the process**, killing every concurrent
  request and every Yjs collaboration socket. Production has no pm2/supervisor
  (`Dockerfile:35`); recovery is a container restart with **no log explaining why**.
- **Most reachable crash path:** `api/src/routes/caia-auth.ts:127` — `await consumeOAuthState(state)`
  sits *outside* the try block (which opens at `:133`) and is a bare `pool.query`. A transient DB
  error during any OAuth callback crashes the API.

### Missing error boundaries

Only two exist, wrapping `<Outlet />` (`App.tsx:542`) and `<EditorContent>` (`Editor.tsx:980`).
Unprotected — a render throw blanks the whole app:

- **Root** (`main.tsx:251-268`) — no boundary, no route `errorElement`
- **The entire AppLayout shell** — sidebar, `CommandPalette`, all modals are *siblings* of the
  boundary, not inside it
- **All context providers** (`main.tsx:196-211`)
- `/login`, `/setup`, `/invite/:token`, `/admin`, `/admin/workspaces/:id`, and the **public**
  `/feedback/:programId`

### Silent failures — top 8 of 15

| # | Where | Consequence |
| --: | --- | --- |
| 1 | `api/src/services/audit.ts:37` | **~40 call sites including failed logins and admin impersonation.** Request returns 200, no record written |
| 2 | `api/src/collaboration/index.ts:176` (fire-and-forget at `:186`) | Editor still reads "Saved"; everything since the last good write is lost on reload |
| 3 | `api/src/routes/documents.ts:1029` | API returns 200 "now private" while unauthorized users **stay connected and keep reading** |
| 4 | `web/src/hooks/useAutoSave.ts:39-46` | Retries 4×, gives up silently; a rename reverts on reload |
| 5 | `useDocumentsQuery.ts:206,214,223` (+ projects/programs/weeks/issues) | Click "New project", nothing appears, no error |
| 6 | `useWeeklyReviewActions.ts:201,237,273` | `.catch(()=>'')` at `:185` erases the server's message first. Reviewer believes an approval succeeded |
| 7 | `CommandPalette.tsx:125,138` | Palette closes, nothing created |
| 8 | `api/src/routes/files.ts:390` | `unlink` failure ignored, DB row deleted anyway → orphaned bytes on disk; retention/GDPR exposure |

**Mitigating factor:** `MutationErrorToast` does surface errors for mutations routed through TanStack
Query. All of the above bypass it (raw `fetch`, `apiPost`, or Yjs).

### Network disconnect recovery — Pass, verified properly

"Saved" was not taken at face value. Blocked `fetch`, killed WebSockets, flipped `navigator.onLine`,
dispatched `offline` → **UI correctly showed "Offline"** (`Editor.tsx:849-874`). Edited the document →
**marker confirmed present in IndexedDB** (`ship-wiki-c3a83130-…`, `updates` store). Restored network
→ **recovered to "Saved" in 2 s** → **independently confirmed via `curl` that the edit reached the
server.** Yjs + IndexedDB works as designed. All 6 test documents were deleted afterwards and the
seed document restored.

### Ranked fixes

1. `useAuth.tsx:105-110` — branch on the actual status code; do not treat 429/5xx as session expiry.
   One condition; stops users being silently ejected mid-session.
2. Add a root error boundary plus boundaries around the AppLayout shell and public routes.
3. Add a global Express error handler and `process.on('unhandledRejection')`. Today an async throw
   **exits the process**, and the JSON-truncation case already leaks absolute paths.
4. Move `caia-auth.ts:127` inside its try — the most reachable crash path.
5. Bound `content` / `properties` with a size cap; reject NULL bytes at the Zod layer.
6. Surface the silent failures — start with autosave, collab persist, and the CRUD hooks.
7. Add request logging — without it, none of the above is diagnosable in production.

---

# Category 7 — Accessibility Compliance

### How it was measured

Lighthouse per page (`npx lighthouse … --only-categories=accessibility --output=json`) and
**axe-core 4.11.1** in a verified authenticated session, tags `wcag2a / 2aa / 21a / 21aa / 22aa`.
Contrast values were also computed statically from source using WCAG relative-luminance.

**Constraint stated plainly: Lighthouse could not authenticate.** All authenticated runs landed on
`/login`. This was proven *not* to be the rate limiter (the API returned 200 immediately before and
after a run) — Lighthouse's `--extra-headers` cookie does not reach the SPA's XHR. **Only `/login`
has a valid Lighthouse score**; axe-core was used for the rest. Keyboard testing was programmatic
(React `onClick` handlers vs. the tabbable set), because the harness could not deliver keystrokes.

### Baseline

| Metric | Baseline |
| --- | --- |
| Lighthouse accessibility score | **`/login`: 98** (fails `landmark-one-main`). Authenticated pages: **not measurable via Lighthouse** |
| Total Critical / Serious violations | **1 Critical** (recurs on every authenticated page) + **22 Serious** (21 contrast + 1 listitem) |
| Keyboard navigation completeness | **Partial** |
| Colour contrast failures | **21 live axe instances** + **11 statically computed source pairs** |
| Missing ARIA labels or roles | ~30 consequential |

### Per-page axe results

| Page | Critical | Serious | Detail |
| --- | --: | --: | --- |
| `/login` | 0 | 0 | Clean; Lighthouse 98, missing `<main>` |
| `/docs` | 1 | 1 | Sidebar tree defect |
| `/documents/:id` (editor) | 1 | 1 | Sidebar only — **the editor itself adds none** |
| `/my-week` | 0 | **18** | all `color-contrast` |
| `/issues` | 0 | 0 | clean — but **793 tabbable elements** |
| `/team/reviews` | 0 | **3** | `color-contrast`; **no `<h1>`** |
| `/team/directory` | 0 | 0 | 1 unnamed checkbox |

**The Critical, root-caused:** `App.tsx:637` sets `<ul role="tree" aria-label="Workspace documents">`
whose children are bare `<li tabindex>` rather than `role="treeitem"`. axe: *"Element has children
which are not allowed: li[tabindex]"*. This also produces the Serious `listitem` violation.
**One fix clears both, on every authenticated page.**

### Contrast — live values static analysis could not see

The 18 failures on `/my-week` come from **runtime opacity modifiers**, which exist only in the
composited page:

| Foreground | Background | Ratio | Source |
| --- | --- | --: | --- |
| `#3f3f3f` | `#0d0d0d` | **1.84:1** | `.opacity-40` rows |
| `#4c4c4c` | `#0d0d0d` | **2.26:1** | `text-muted/50` @ 11 px |
| `#005ea2` | `#0a1d2b` | **2.55:1** | `bg-accent/20` pill |
| `#005ea2` | `#0c1114` | **2.82:1** | `.text-accent` |

**`/my-week` is the only page the existing contrast test scans**
(`accessibility-remediation.spec.ts:738`, filtered to `color-contrast`, asserting zero) — and it has
**18 live violations**.

**The most damaging single value:** the focus ring is `outline: 2px solid #005ea2`
(`web/src/index.css:28`) at **2.89:1**, below the **3:1** required by SC 1.4.11 — and it is the only
focus style app-wide.

**`statusColors.ts` is genuinely correct** — all 11 pills clear AA at 8:1+. The problem is that it is
optional and widely bypassed (`Documents.tsx:364,436`; `ProjectRetro.tsx:212,229`;
`WeekReview.tsx:161,175`).

**Hidden failure mode:** `web/tailwind.config.js` has **no `darkMode` key**, so it defaults to
`'media'` while the app is hardcoded dark. For any user whose **OS is set to light**, every `dark:`
variant drops and 5 more pairs fail (2.86–4.02:1). Playwright's default colorScheme is light, so the
suite runs in exactly that configuration and still passes — because the contrast scan only visits
`/my-week`, where the affected component isn't rendered.

### Keyboard navigation — Partial

**Good:** zero elements with `tabIndex > 0` anywhere; 0–1 unnamed tabbable per page; skip link,
`role="navigation"`, `<main tabIndex={-1}>`, `aria-current="page"` all present; `CommandPalette` has a
real focus trap with a `focusin` fallback; roving tabindex in `ContextMenu` / `SelectableList` is
textbook.

**Gaps:** 6 clickable `<div>`s with no role, tabIndex or key handler — worst is
`AccountabilityGrid.tsx:406`, repeated per person × per week, making the whole grid
keyboard-inoperable. `KanbanBoard.tsx:271` is focusable with no `onKeyDown`. 9 icon-only buttons with
no accessible name. **3 dialogs declare `aria-modal="true"` but never trap focus**
(`ConversionDialog.tsx:38`, `MergeProgramDialog.tsx:138`, `BacklogPickerModal.tsx:216`) — the
attribute tells assistive tech the background is inert when it is not.
`UploadNavigationWarning.tsx:13` is a blocking destructive dialog with **zero** dialog semantics.
And `/issues` presents **793 tabbable elements** with no bypass mechanism.

### The compliance claims are not supported

`README.md:16-17` ships static shields.io badges (no link target) asserting **Section 508 Compliant**
and **WCAG 2.1 AA**; `:265` claims *"All color contrasts meet 4.5:1 minimum"* and `:268` *"Visible
focus indicators"*.

**The contrast claim is false** — 21 live violations measured, and the focus indicator fails the 3:1
it needs.

**There is no supporting artifact.** No VPAT, no ACR, no audit report anywhere in the repo.
`ATTESTATION.md` is security-only. `code.json` declares `"status": "Development"` — in direct tension
with a finished-compliance badge. And `accessibility-remediation.spec.ts:8` cites
`plans/508-accessibility-remediation.md` as its authority: **that file has never existed**
(`git log --all` on the path is empty — verified).

**The test suite versus what was measured:** of 57 tests, **26 (46%) would still pass if the feature
they name were deleted** — 9 have guards that skip all assertions, 5 have `||` escape hatches, 2 use
`-1` sentinels (deleting the `<nav>` makes one pass *more* reliably), and 2 contain no `expect()` at
all. The 4 axe scans filter to `critical`/`serious` only, discarding moderate and minor. Never
scanned: `/documents/:id` (the primary editing surface), `/settings`, `/admin`, `/projects`, all
`/team/*`, the public `/feedback/:programId` — and no modal state, ever. There is no CI, so none of
it gates anything.

**In fairness to the prior effort:** the strong tests are genuinely strong (focus trapping with 10×
Tab, `aria-describedby` on form errors, skip links, no-nested-interactive), and the app shell,
`CommandPalette` and `statusColors.ts` are well built. The problem is that the badge asserts verified
conformance the evidence does not reach.

### Ranked fixes

1. `index.css:28` — focus ring 2.89:1, below the 3:1 floor. One line, every focusable element, and
   the clearest contradiction of the badge.
2. `App.tsx:637` — give the tree's `<li>` children `role="treeitem"`. Clears the only Critical, on
   every page.
3. Fix the `opacity-40` / `text-muted/50` patterns on `/my-week` (18 violations, worst 1.84:1).
4. Set `darkMode: 'class'` — currently degrades silently for every light-OS user and is untestable by
   construction.
5. Port `UploadNavigationWarning` to a real dialog; add focus traps to the 3 dialogs claiming
   `aria-modal` without one.
6. `AccountabilityGrid.tsx:406` and the 9 unnamed icon buttons; add an `<h1>` to `ReviewsPage`.
7. Extend axe to `/documents/:id` and open-modal state, stop filtering out moderate violations, and
   put it in CI.
8. Either produce a real ACR/VPAT or soften `README.md:16-17` and `:263-268` — as it stands it is an
   unbacked federal compliance claim.

---

# Category 8 — Terraform Plan Review

### How it was measured

Terraform **v1.15.8** (`.terraform-version` pins 1.6.0; every `required_version` is `>= 1.6.0`, so
1.15.8 satisfies all of them). `init -backend=false`, `validate`, `fmt -check -recursive` and
`providers` were run across **all 11 locations**. **`apply` and `destroy` were never run against the
repo's infrastructure** — the only `apply` was in a throwaway scratch config touching scratch files.

All seven lock files that `init` dirtied were restored; **`terraform/` was verified byte-identical to
HEAD** afterwards.

### Structure and provider audit

42 `.tf` files: 12 flat root files, `bootstrap/`, three environments, six modules.
`terraform fmt -check -recursive`: **exit 0, zero violations, tree-wide.**

| Location | `init -backend=false` | aws | random | `validate` |
| --- | --- | --- | --- | --- |
| `terraform/` (root) | ok | **5.100.0** | 3.9.0 | Success **+1 warning** |
| `bootstrap/` | ok | 5.100.0 | — | Success |
| `environments/dev` | ok | 5.100.0 | 3.9.0 | Success +1 warning |
| `environments/prod` | ok | 5.100.0 | **3.7.2** | Success +1 warning |
| `environments/shadow` | ok | 5.100.0 | 3.9.0 | Success +1 warning |
| `modules/vpc` | ok | **6.28.0** | — | Success, no warning |
| `modules/aurora` | ok | **6.28.0** | 3.7.2 | Success, no warning |
| `modules/elastic-beanstalk` | ok | **6.28.0** | — | Success, no warning |
| `modules/cloudfront-s3` | ok | **6.28.0** | — | Success, no warning |
| `modules/security-groups` | ok | **6.28.0** | — | Success, no warning |
| `modules/ssm` | ok | **6.28.0** | 3.7.2 | Success, no warning |

### Findings

**1. A major-version split determined by which directory you stand in — proven empirically.** Same
repo, same command, same minute: roots install **aws 5.100.0**, modules install **aws 6.28.0**.

**2. The six modules declare no `required_providers` at all — and Terraform says nothing.** No
warning, no error; all six validate clean. Terraform silently infers `hashicorp/aws` from the
`aws_*` prefix and, absent any constraint, takes the newest release. `terraform providers` renders the
gap exactly — root carries `~> 5.0` / `~> 3.6`, every module line is bare. Two modules
(`aurora`, `ssm`) use `random_password` without declaring the `random` provider.

**3. The tracked lock files are the wrong ones, and `.gitignore` cannot fix it.** The hypothesis was
a pattern-matching failure; the real cause is precedence. `terraform/.gitignore:7` (`.terraform.lock.hcl`,
no leading slash) already matches **every** lock path at any depth. But `git ls-files -v` returns `H`
for the module and prod locks — they were committed in `2c1c633`, **the same commit that added the
ignore rule**, and gitignore has no power over already-tracked files. The fix is `git rm --cached`,
not a pattern edit. The module locks additionally carry **no `constraints` line**, the signature of
someone running `init` inside a module directory where nothing constrains resolution.

**4. `terraform init` dirties 7 tracked lock files on Windows.** The locks were generated
single-platform and lack `windows_amd64` hashes, so a plain `init -backend=false` produces a spurious
diff and a "review and commit these changes" prompt for every Windows contributor. Fix:
`terraform providers lock -platform=windows_amd64 -platform=linux_amd64 -platform=darwin_arm64`.

**5. The three environments resolve *different* `random` versions.** `prod` has a lock and pins
**3.7.2**; `dev` and `shadow` have none and both resolved **3.9.0** — under an identical `~> 3.6`
constraint. Environments meant to be equivalent are not, and the locked one is the **oldest**.

**6. No state locking anywhere.** Four `backend "s3"` blocks, **zero** `dynamodb_table`, zero
`use_lockfile`. Concurrent applies — two engineers, or CI racing a human — can corrupt state with no
interlock and no recovery table.

**7. The root `.tf` files are a drifted fork of `modules/`, and the module path silently drops
security controls.** The 12 root files duplicate the six modules and have diverged (8–143 lines
each). The divergence is consistently in the direction of the modules being weaker:

| Control | Root | Module |
| --- | --- | --- |
| CloudFront WAF (`web_acl_id`) | `s3-cloudfront.tf:117` sets it | **absent entirely** |
| Rate limiting (`waf.tf`) | present — documented as *the* DDoS control | **no module counterpart** |
| Real-time logging (`realtime_log_config_arn`) | `s3-cloudfront.tf:255` | absent |
| Bedrock IAM (`bedrock:InvokeModel`) | `ssm.tf:158-173` | absent |

**Anything applied via `environments/{dev,prod,shadow}` gets a CloudFront distribution with no WAF
and no rate limiting.** Both trees also target overlapping resource *names* from **different state
files** (`ship/terraform.tfstate` vs `ship/prod/terraform.tfstate`), so applying both against one
account means two states fighting over the same physical resources. It is not evident which is live.

**8. A committed plan file leaks account data.** `terraform/environments/shadow/tfplan` — 28 kB,
tracked in git (`2917885`). Unpacked, it contains a `tfstate` holding the 12-digit **AWS account ID**,
the caller **IAM ARN**, **5 VPC/subnet IDs**, and resolved `/infra/dev/*` SSM values. This defeats
the stated control: `bootstrap/main.tf:62` says the SSM indirection *"avoids committing account ID to
git"*. No passwords in this particular file (it is a serial-0 pre-apply plan), but a plan captured
*after* apply would embed `random_password.db_password.result` in cleartext — and `.gitignore:72-73`
covers `*.tfplan` only at `terraform/` root, not under `environments/*`.

**9. Aurora can be destroyed without a snapshot.** `skip_final_snapshot = var.environment != "prod"`
means dev and shadow take **no final snapshot** on destroy, and
`grep -rn "deletion_protection\|prevent_destroy"` returns exactly **one** hit repo-wide
(`bootstrap/main.tf:23`) — the prod Aurora cluster has **none**. Combined with several ForceNew
attributes on the cluster, that is one careless variable edit from unrecoverable data loss.

**10. A forward-compatibility break, surfaced by tooling not reading.**
`aws_s3_bucket_lifecycle_configuration.uploads` needs an explicit `filter {}`:
*"No attribute specified when one (and only one) of [rule[0].filter, rule[0].prefix] is required.
This will be an error in a future version of the provider."* It fires under 5.100.0 but **not** under
6.28.0 — so the version split has observable semantic consequences today.

**11. An undeclared external dependency.** `/infra/dev/{vpc_id,private_subnet_ids,public_subnet_ids,vpc_cidr}`
are **read** by `environments/dev/main.tf:4-17` and `environments/shadow/main.tf:25-38` but
**created by nothing** in the repo. Both environments hard-fail on a clean account.

**12. Shadow's stated purpose is unimplemented — and its outputs claim otherwise.**
`snapshot_identifier` is documented and declared but `modules/aurora` never accepts it. Worse,
`environments/shadow/outputs.tf:106,113` **report the snapshot as the source** when it was never
applied — an output that actively lies about data provenance during migration testing.

### Blast radius — classification

No plan output could be produced (see below), so this is **static reasoning from provider ForceNew
semantics, and must be re-verified against a real plan.** `validate` does not evaluate these.

**Would be RECREATED — downtime, some with data loss:** `aws_rds_cluster` (ForceNew on
`database_name`, `master_username`, `storage_encrypted`, `db_subnet_group_name`, `engine_mode`) —
total DB replacement, unrecoverable in dev/shadow given `skip_final_snapshot`;
`aws_rds_cluster_instance` — full downtime, no failover target on serverless v2;
`aws_rds_cluster_parameter_group` — **the apply will likely fail mid-run**, since there is no
`create_before_destroy` and AWS refuses to delete a parameter group still attached;
`aws_elastic_beanstalk_environment` (ForceNew on `name`, and VPC placement is not mutable in place) —
new CNAME leaves the CloudFront origin stale, **API 5xx until CloudFront re-applies**;
`aws_s3_bucket` (name embeds `account_id`) — apply fails rather than destroys, since Terraform cannot
delete a non-empty bucket; `aws_vpc` / `aws_subnet` / `aws_nat_gateway` — environment-wide teardown
(prod only).

**Modified in place:** Aurora `engine_version`, backup windows, serverless scaling; all non-VPC EB
settings (`RollingWithAdditionalBatch` with `BatchSize = 1` makes this genuinely zero-downtime); the
three security groups; all 9 `aws_ssm_parameter` — note **`DATABASE_URL` and `DB_PASSWORD` change
whenever `random_password` regenerates**, and EB instances read these at boot, so the app keeps stale
credentials until the next deploy.

**Safe no-op:** bucket versioning / SSE / public-access-block, CloudWatch log groups, OAC and
cache policies, ACM + Route53 (correctly using `create_before_destroy`), EB application, IAM roles.

**One genuine mitigation worth crediting:** `final_snapshot_identifier` embeds `timestamp()`, which
would normally cause a perpetual diff — correctly neutralised with `lifecycle { ignore_changes }`.
Same pattern for the EB `version_label`.

### Drift detection — executed

Provider pinned **exactly** (`constraints = "2.5.2"`, not `~>`), confirmed in the generated lock.
`init` → `Installing hashicorp/local v2.5.2 … (signed by HashiCorp)`; `fmt -check` exit 0;
`validate` Success; `apply` → 2 added.

**Before (clean plan, post-apply):**
```
No changes. Your infrastructure matches the configuration.
```

**Out-of-band tamper (no Terraform involved):**
```
- {"env":"drift-demo","logLevel":"info","replicas":2,"service":"ship-api"}
+ {"env":"drift-demo","logLevel":"debug","replicas":9,"service":"ship-api"}
```

**After (drift detected):**
```
Note: Objects have changed outside of Terraform

  # local_file.config has been deleted
  - resource "local_file" "config" {
      - content_sha256 = "6f663aac…af523" -> null
        id             = "8302365e2f7608995e9ec64003e79b262f0cb3a3"
    }
─────────────────────────────────────────────────────────────────────
  # local_file.config will be created
Plan: 1 to add, 0 to change, 0 to destroy.
```

**Two behaviours worth recording before generalising this demo.** `local_file` reports drift as
**deleted → re-add**, not an in-place content diff — the provider's Read compares `content_sha256`
and, on mismatch, drops the resource from state. So the plan shows the *desired* content, never the
tampered value: you learn *that* it drifted, not *what to*. On a real AWS resource this would be a
`~ update in-place` with both sides visible. Second, the untampered `local_file.readme` produced **no**
drift entry, confirming detection is per-resource rather than a blanket refresh.

### The exact failure boundary without AWS credentials

**Stage 1** — `plan` after `init -backend=false`:
`Error: Backend initialization required` · *Reason: Initial configuration of the requested backend "s3"*

**Stage 2** — full `init`:
`Error: Missing Required Value … The attribute "bucket" is required by the backend` (`versions.tf:17`)

**Stage 3** — with a placeholder bucket, to reach the auth layer:
`Error: No valid credential sources found … no EC2 IMDS role found … 169.254.169.254: unreachable network`

**A reviewer without AWS access gets exactly this far:** full `init -backend=false`, `validate`,
`fmt`, and `providers` (the last only with the backend stripped). **Zero plan output, and none has
been invented.** The blocker is two-layer — the missing `bucket` stops you before credentials are
consulted, and the SSM bootstrap that supplies it is itself gated behind those same credentials.

### Week-4 provider gap — confirmed

```
grep -rn "hashicorp/local|local_file|provider \"local\""   terraform/  -> ZERO
grep -rni "render-oss|provider \"render\"|render_"          terraform/  -> ZERO
```

Both required providers are **fully greenfield**. The existing stack is 100%
AWS / Elastic Beanstalk / CloudFront, deployed by hand-rolled bash (`scripts/deploy-*.sh`).

> **Correction (2026-07-29):** true at `076a183`. Both greps now hit: `cc23a74` added
> `terraform/local/` (hashicorp/local 2.5.2) and `0fbe706` added `terraform/render/`
> (render-oss/render 1.9.1) as Phase-2 work, post-draft — see the Post-draft change log.

### Honest scope note

`validate` passing on both the root and module trees says **nothing** about the WAF/logging/Bedrock
gap — a config that omits a WAF is perfectly valid Terraform. No static check catches that; only a
plan diff against a live environment, or a policy tool (`tflint`, `checkov`, OPA), would.

---

# Corrections made during this audit

Recorded rather than smoothed over. **A wrong number in a pass/fail report is worse than a missing
one**, and nine claims did not survive verification.

| Claim | Outcome |
| --- | --- |
| **"Six e2e tests are empty and the hook correctly blocks them"** | **Withdrawn — inverted.** All six contain real `expect()` assertions; the *detector* has a body-termination bug. The corrected finding is worse: the hook fails on **every** commit regardless of content, so the repo's only gate is routinely bypassed. |
| **"Migration 033 breaks fresh installs"** | **Mechanism corrected.** The loop dies 23 migrations earlier, at `010`, **silently and with exit code 0**. The conclusion held; the failure mode, the location and the blast radius were all different. |
| **"The unusable GIN index is the #1 optimisation target"** | **Demoted.** Category 4 proved the mechanism is broken (136 ms vs 0.107 ms under forced conditions); Category 3 measured its actual cost at **0.34 ms**. Reclassified as a **scaling landmine, not today's bottleneck.** |
| **"`package.json` has an encoding defect"** | **Withdrawn.** The non-ASCII byte is an emoji in a script string — a console code-page artefact. |
| **"pnpm version mismatch"** | **Withdrawn.** Corepack honoured the `packageManager` pin and auto-switched to 10.27.0. |
| **"No shutdown hook exists"** | **Corrected.** `SIGTERM` *is* handled (`db/client.ts:29`) — but only to close the DB pool, not to flush pending Yjs saves, so the pool closes while debounced writes are queued. Arguably worse than having none. |
| **"`.gitignore` fails to match the module lock files"** | **Mechanism corrected.** The pattern matches every lock path fine; the files are tracked because they landed in the same commit that added the rule. Requires `git rm --cached`. |
| **"Escape does not close the Action Items modal"** | **Withdrawn before publication.** A dispatched `KeyboardEvent` did close it; the automation harness was not delivering keystrokes. |
| **"The load test polluted the seed set"** | **Withdrawn.** The 300 `Load test …` documents are the audit's own volume-extension data. Document count verified back at exactly 557. |

---

# What remains open

**One cell of one table: the E2E suite's pass/fail/flaky/runtime.** 869 tests — 59% of the total —
cannot start on this host because of the two defects in Category 5. They were **deliberately not
fixed**, for two reasons: the assignment forbids fixing during the audit, and *"the suite is
unrunnable as shipped"* is itself a finding whose before-state is worth preserving for a Phase-2
improvement with real before/after proof.

A Linux environment (WSL2 Ubuntu) has been installed to measure the suite **without editing the
repo**, so the finding stays intact and the number becomes real. Until then the honest entry is
"not measured", with the reason — not an estimate.

---

# Method notes

- **Every category was measured by an independent pass, then headline claims were re-verified
  separately.** Where a pass and the re-check disagreed, the disagreement is recorded above rather
  than resolved silently.
- **Measurements that share the running system were serialised**, not parallelised — a load test
  running during query-counting would corrupt both baselines, and the assignment requires before/after
  comparisons under identical conditions.
- **Nothing was fixed.** No source, index, query, test, config or Terraform change. The api test suite
  was run against a throwaway `ship_test` database specifically to avoid the `TRUNCATE` hazard in
  Category 5. Six test documents created during Category 6 were deleted and the seed document restored.
  *(Correction 2026-07-29: accurate for the measurement window at `076a183`; eight later commits
  changed the repository before this report was reconciled with them — see the Post-draft change log.)*
- **Scratch harnesses** (load generator, log parser, type counter, sourcemap attributor, drift demo)
  live outside the repo in the session scratchpad, with reproduction commands quoted in each section.
  *(Correction 2026-07-29: committed into [`bench/`](bench/README.md) by `0706a13` on 07-28,
  post-draft — see the Post-draft change log.)*

---

# Post-audit measurement execution (2026-07-29/30)

Four measurements the audit disclosed as unexecuted (★ rows in [Measurement
limits](#measurement-limits)) are being executed now, after the audit, and recorded here as dated
post-audit evidence. The original disclosures stand untouched — what the audit knew, and when, is
part of the record. Each subsection states method, exact command, evidence path, result, and whether
the Phase-1 reasoned finding was **confirmed** or **revised**.

## Real keyboard traversal — executed 2026-07-29

**Method:** `e2e/keyboard-traversal.spec.ts` — real `page.keyboard.press` keystrokes via Playwright
against live dev servers. **Command:** `pnpm exec playwright test e2e/keyboard-traversal.spec.ts
--workers=1`. **Evidence:** `bench/cat7-a11y/out/keyboard-traversal-rebaseline-0bfc3d6.json`
(app code identical across `0bfc3d6`–`16a351b`; only docs/tests changed between those commits).

**Result: 4/4 pass.** Email, password and Sign-in are all reachable by real Tab presses and
Shift+Tab reverses; Enter alone submits the form; a 100-Tab walk of `/docs` found **no keyboard
trap** and visited interactive elements with a **focus-visible ratio of 1.0** (every stop had some
visible indicator — presence, not contrast, which remains the 2.89:1 Cat-7 finding); exactly **1
unnamed interactive stop** was recorded; the editor is reachable by Tab on a document page.

**Verdict vs Phase-1 reasoning: largely confirmed, one revision.** The programmatic analysis
predicted reachability, which held. It could not have shown that the harness-level "Tab did not
move focus" defect was an audit-tooling artifact rather than an app defect — real keystrokes work
fine. (One recorded no-focus-ring stop is the TanStack Query devtools button, dev-mode only.)

## Concurrent two-user editing — executed 2026-07-29

**Method:** `e2e/collab-convergence.spec.ts` — two Playwright contexts, two distinct users
(`dev@ship.local`, `bob.martinez@ship.local`), same `/documents/:id` = same Yjs room. **Command:**
`pnpm exec playwright test e2e/collab-convergence.spec.ts --workers=1`. **Evidence:**
`bench/cat5-collab/out/convergence-rebaseline-0bfc3d6.json`.

**Result: 2/2 pass.** Concurrent edits at different positions were delivered in both directions and
both editors converged to identical content within **≤ 848 ms**. Same-position concurrent typing
(10 chars per user at the same caret) lost **zero characters** and converged identically.

**Verdict vs Phase-1 reasoning: confirmed, with one observation reasoning missed.** The CRDT
no-loss claim held under real concurrent sessions. Newly observed: same-position concurrent typing
**interleaves the two users' text character-by-character** (e.g. `alphbar-a1v7o8-…`) — correct CRDT
behavior with no data loss, but a UX surprise no code-reading predicted. The first run of the spec
also surfaced that each editor renders the *other* user's cursor label into the DOM, which any
DOM-diffing comparison must strip. The multi-instance split-brain risk remains out of scope
(single-instance dev server), as § Measurement limits already stated.

## 3G / throttled network — executed 2026-07-29

**Method:** `e2e/network-3g.spec.ts` — CDP `Network.emulateNetworkConditions` with Chrome DevTools
Regular-3G and Slow-3G presets, against the **production build** served by `vite preview` (API
proxied to the live dev API). **Command:** `pnpm exec playwright test e2e/network-3g.spec.ts
--workers=1`. **Evidence:** `bench/cat2-bundle/out/3g-rebaseline-0bfc3d6.json`.

**Result: 4/4 pass.** Cold `/login` becomes usable in **7.2 s on Regular-3G** and **14.3 s on
Slow-3G** (605 kB transferred — the Cat-2 "before" for code splitting). The authenticated
docs-to-editor flow completed and **zero loading indicators remained** after settle on both
profiles — no hanging spinners under pure slow-network conditions.

**Verdict vs Phase-1 reasoning: refined.** The audit's 15 silent failures were found by *inducing
API errors*; this run shows a merely *slow* network does not by itself reproduce them — the app
loads and settles. A first attempt against the dev server exceeded 120 s DOMContentLoaded on
Regular-3G, which is a dev-mode artifact (hundreds of unbundled ESM modules), recorded here so
nobody mistakes it for the production number.

## Screen reader (NVDA) — pending execution

*Planned:* manual NVDA session per `docs/nvda-session-script.md`; Speech Viewer transcript and
per-step pass/fail findings to `bench/cat7-a11y/out/nvda-session-2026-07-29.md`.

---

# Phase-2 results summary (as of 2026-07-29)

Every number below is a committed artifact pair — never a comparison against this report's
audit-window prose (see Post-draft change log for why). Full narrative, rollback steps and known
debt: [`CHANGES.md`](CHANGES.md).

| Cat | Target | Re-baseline | After | Delta | Evidence pair | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Type safety | −25% violations | 1,208 | 882 | **−27.0%** | `bench/cat1-types/out/rebaseline-8e69a59.txt` → `after-9cc5aeb.txt` | ✅ met |
| 2 Bundle | −20% initial load | entry+css ≈2,088 kB; 3G cold-login transfer 605 kB, usable 7.2 s/14.3 s | 872 kB; 243 kB, 3.7 s/7.1 s | **−58% / −59.9%** | `bench/cat2-bundle/out/rebaseline-8e69a59-*` → `after-c22fea4-*`, `3g-*` pair | ✅ met (~3× target) |
| 3 API P95 | −20% on ≥2 endpoints | `/api/auth/me` 93.7/127.4 ms | 34.9–49.7 / 70.5–92.8 ms | **−47..−63% / −27..−45%** (both runs) | `bench/cat3-latency/out/` + `NOTES-2026-07-29.md` | ◐ met on 1 of 2; second endpoint parked with committed diagnosis (dev-mode Node-bound, ±20% run noise; three fix attempts recorded) |
| 4 Queries | −20% on one flow | main page 41 queries | 32 | **−22.0%** | `bench/cat4-queries/out/rebaseline-16a351b_mainpage.txt` → `after-9c00675_mainpage.txt` | ✅ met |
| 5 Tests | 3 meaningful tests on untested paths | real-time sync, keyboard access, slow-network behaviour: zero coverage | 3 assertive specs (risk comments in-file) + 13 failing tests fixed with RCAs + 8 new regression tests | — | `e2e/{keyboard-traversal,collab-convergence,network-3g}.spec.ts`; suites api 453/453, web 160/160 | ✅ met |
| 6 Errors | 3 gaps, ≥1 user-facing data loss | silent migration exit-0; process-killing rejections; blip-forced logout | all fixed + the test-suite TRUNCATE guard (4th, found live) | — | `docs/pr-evidence/week4-cat6/` before/after transcripts | ✅ met (4 gaps) |
| 7 A11y | 0 Critical/Serious on 3 key pages | 1 critical + 13 serious nodes; focus ring 2.89:1 | 0/0 on /login, /docs, /my-week; ring 3.78:1 | — | `bench/cat7-a11y/out/axe-rebaseline-d6e9fee.json` → `axe-after2-d6e9fee.json`; keyboard 4/4 re-run | ✅ met |
| 8 Terraform | local ≥2 resources + Render deploy | — | local: complete, pinned 2.5.2, drift demo captured (`terraform/local/out/01..14`); Render: project+postgres applied, pinned 1.9.1 | — | `terraform/{local,render}/out/` | ◐ web service awaits GitHub mirror + owner's Render authorization (registry rejects labs.gauntletai.com; rejection captured) |

Outstanding, human-gated: NVDA session results (protocol delivered; recorded only as executed) and
the Cat-8 Render authorization. Neither is claimed above.
