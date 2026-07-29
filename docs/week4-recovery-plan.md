# Week-4 Recovery: Audit Feedback Fixes + Friday Implementation Checkpoint

## Context

Grader feedback on the Phase-1 audit praised the measurement rigor (forced-seqscan test, Little's Law closure, corrections table) but flagged two failures:

1. **The diagnose/fix boundary broke.** [AUDIT_REPORT.md:6](AUDIT_REPORT.md) claims "Nothing was fixed. No source file, index, query, test, or Terraform config was modified" — but 8 non-doc commits landed after the report's first draft (`97c0fdc`, 07-27 14:49): `0706a13` (bench harness), `f07264a`, `ebd8f95` (build tooling — falsifies report lines 211/635/639), `fe67e55`, `cc23a74` (terraform/local — falsifies Cat-8 "fully greenfield" at 1192–96), `0fbe706` (terraform/render), `bba9801` (`api/src/app.ts` +36 runtime lines), `95277d0`. The report was never reconciled.
2. **Four measurements were never executed** — screen reader, real keyboard traversal, 3G throttling, concurrent two-user editing. Code reasoning stood in. Three are disclosed in REMEDIATION_PLAN.md:205–207; keyboard traversal isn't disclosed anywhere as a limit, and the Limits table isn't in the audit report a grader reads.

Deadline: **Friday 11:59 PM** implementation checkpoint — measurable improvement in all 8 categories + implementation rules (CI, CHANGES.md, one-command start, etc.). Phase-2 work has not started in 7 of 8 categories (Cat 8 is one variable away from done). User decisions: target Friday; user will run a manual NVDA session from a script we write; user approved mirroring the fork to GitHub so `terraform apply` on Render can complete.

**Skill rule that governs everything:** never regenerate Phase-1 discovery evidence. Original baselines stay untouched; deltas are computed against fresh **re-baselines at current HEAD**, committed before each fix, labeled `rebaseline-<sha>` under `bench/cat<N>-<slug>/out/` (pattern from `terraform/local/out/01..14`).

**Standing conditions for every bench run** (per [bench/README.md](bench/README.md)): Git Bash, Docker `shipshape-postgres-1` on 5433 with the 557-doc volume seed, dev servers via `scripts/dev.sh`, HEAD SHA recorded in every artifact. Watch: 1000 req/60s rate limiter (`api/src/app.ts:81`), 15-min absolute session expiry.

---

## Wednesday evening

### W1 — [GATE] AUDIT_REPORT.md honesty amendment (first commit, before any new code)
- **Header (lines 6–7), edit in place:** scope the no-fix claim to the measurement window ("measurements taken at `076a183`, clean tree verified per measurement; commits landed after the first draft — see Post-draft change log").
- **New section `## Post-draft change log (added 2026-07-29)`** immediately after the companion-documents block, before Reproducibility conditions. Intro paragraph owning the error, then a table: Commit | Date | What changed | Report claims affected | Baselines invalidated | Disposition — one row per post-draft commit (8 rows, details above).
- **In-place corrections** at lines 211, 635, 639, 1192–96: keep original sentence, append dated blockquote `> **Correction (2026-07-29):** superseded by <sha> — see Post-draft change log.`
- **New section `## Measurement limits`** after Reproducibility conditions: copy the Limits table from REMEDIATION_PLAN.md:192–208 (leave a pointer there), **add the missing row for real keyboard traversal** (Phase-1 keyboard results were programmatic — report's own admissions at 738–741, 877–878).
- **Stub `## Post-audit measurement execution (2026-07-29/30)`** at end with four empty subsections (keyboard / NVDA / 3G / two-user), each to be filled with date, method, command, evidence path, result, and confirmed/revised verdict vs the Phase-1 reasoned finding.
- Commit: `docs(audit): reconcile post-draft commits; scope the no-fix claim; add measurement-limits table`.

### W2 — [GATE] Fix the 13 failing web tests
`web/src/lib/document-tabs.test.ts` ×9, `DetailsExtension.test.ts` ×3, `useSessionTimeout.test.ts` ×1. "Tests must still pass" invalidates every later fix commit until green. One commit per file with one-line RCA in the message (feeds Cat-5's flaky-fix alternative). Verify: `pnpm -C web test`.

### W3 — [GATE] NVDA session script → hand to user
Write `docs/nvda-session-script.md`: NVDA install + Speech Viewer, app via `pnpm dev` (Git Bash), login `dev@ship.local` / `admin123`; numbered protocol (login-form announcement, landmark/heading nav on doc list, editor typing echo, toolbar names, modal focus trap/return) each with expected/observed/pass-fail rows. Results template → `bench/cat7-a11y/out/nvda-session-2026-07-29.md`. **User runs it tonight or Thu; Thu evening is the last safe slot.**

### W4 — [GATE] Write the three automatable measurement specs (run Thu AM)
All use `e2e/fixtures/dev-server.ts` (attaches to running dev servers). Creds: `dev@ship.local` / `bob.martinez@ship.local`, both `admin123`. Editor route `/documents/:id` = Yjs room.
1. **`e2e/keyboard-traversal.spec.ts`** — real Tab/Shift+Tab/Enter/Escape walks on login, doc list, editor (patterns: `e2e/accessibility-remediation.spec.ts`). Asserts reachability + logical order, visible focus (computed outline — behavioral twin of the 2.89:1 focus-ring finding), no traps, modal Escape restores focus. Dumps focus order → `bench/cat7-a11y/out/keyboard-traversal-<sha>.json`. Doubles as Cat-5 test #1.
2. **`e2e/collab-convergence.spec.ts`** — two contexts (pattern: `e2e/private-documents.spec.ts:412`; upgrades the near-miss at `e2e/performance.spec.ts:195` which never asserts convergence), both users on the same `/documents/:id`: (a) concurrent edits at different positions → editors identical ≤10s; (b) same-position conflict → no character loss. Convergence latency → `bench/cat5-collab/out/convergence-<sha>.json` (new dir). Cat-5 test #2 — real-time sync has zero coverage.
3. **`e2e/network-3g.spec.ts`** — `context.newCDPSession(page)` + `Network.emulateNetworkConditions` (no existing throttling code anywhere), Regular-3G and Slow-3G profiles; measures cold `/login` and doc-list/editor open; asserts every spinner resolves or errors ≤60s (targets the 15 silent-failure findings). → `bench/cat2-bundle/out/3g-rebaseline-<sha>.json`; re-run after Cat-2 split → `3g-after-<sha>.json`.
- Commits: one per spec (`test(cat5): …`, `test(cat2): …`).

## Thursday

### T0 — [GATE] Morning: one-sitting re-baseline + measurement execution at a single HEAD
| Capture | Command | Output |
|---|---|---|
| Types | `node bench/cat1-types/count-types.mjs` | `bench/cat1-types/out/rebaseline-<sha>.txt` |
| Bundle | sourcemap build + `node bench/cat2-bundle/smattr.mjs` | `bench/cat2-bundle/out/rebaseline-<sha>.json` |
| Latency | `bench/cat3-latency/` harness | `bench/cat3-latency/out/rebaseline-<sha>.*` |
| Queries | `bench/cat4-queries/` main-page flow | `bench/cat4-queries/out/rebaseline-<sha>.*` |
| 3 specs | `pnpm exec playwright test e2e/keyboard-traversal.spec.ts e2e/collab-convergence.spec.ts e2e/network-3g.spec.ts` | paths above |

Fill the Post-audit measurement execution addendum with results (feedback #2 closed except NVDA). Commits: `bench: re-baseline all categories at <sha>; execute keyboard/collab/3G measurements`, `docs(audit): record post-audit measurement results`. Keep latency runs <10 min (session expiry) and under the rate limit.

### T1 — [GATE] Cat 3 + Cat 4 (shared root cause)
- Throttle the per-request `UPDATE sessions SET last_activity` at [auth.ts:205](api/src/middleware/auth.ts:205), copying the `COOKIE_REFRESH_THRESHOLD_MS` pattern at :212. **Constraint:** `last_activity` drives the 15-min inactivity timeout — skip the write only when staleness stays ≪ timeout (60s threshold is safe); keep `useSessionTimeout.test.ts` green.
- Cat-4 second lever: collapse the 48-query main-page shell fan-out (of 57 total). Migration 038 only if an index emerges.
- After each fix: re-run harnesses under identical conditions → `out/after-<sha>.*`. Targets: −20% P95 on ≥2 endpoints; −20% queries on one flow.
- Commits: `perf(cat3): throttle session last_activity writes`, `perf(cat4): collapse main-page shell query fan-out`.

### T2 — [GATE] Cat 1 — types
- `AuthenticatedRequest` in [api/src/middleware/auth.ts](api/src/middleware/auth.ts) making `userId` required post-auth → removes 236 `req.userId!` sites (~72% of the `!` baseline; clears −25% overall alone).
- `web/tsconfig.json` extends root (surfaces 102 hidden errors) — **timebox 2h**; if unclearable, ship with documented per-site suppressions and say so in CHANGES.md.
- After: `count-types.mjs` → `out/after-<sha>.txt`; run full api+web suites.
- Commits: `refactor(cat1): AuthenticatedRequest — remove 236 non-null assertions`, `fix(cat1): web tsconfig extends root`.

### T3 — [GATE] Cat 2 — bundle
- Add `build` block to [web/vite.config.ts](web/vite.config.ts): route-level `React.lazy` split of the editor route (main chunk = 92.1% of JS) + the two file-level fixes at REMEDIATION_PLAN.md:151 (≈19%); target the −20% initial-load alternative.
- After: sourcemap build + smattr → `out/after-<sha>.json`; re-run `network-3g.spec.ts` → real-world proof the split matters.
- Commit: `perf(cat2): code-split editor route; vite build config`.

### T4 — [GATE] Cat 6 — error handling (evening)
1. [api/src/db/migrate.ts:102](api/src/db/migrate.ts:102) catch-all swallows migration failures, exits 0 — the data-loss headliner. Repro with an intentionally broken local migration; capture before (silent exit 0) / after (non-zero, logged).
2. Transient-error-logs-you-out bug. 3. Unhandled-rejection process exit.
- **Evidence trap:** `*.png` and `evidence/` are gitignored — commit screenshots under `docs/pr-evidence/` and verify with `git check-ignore -v` first; add negation if needed.
- Commits: one per gap, repro steps + evidence paths in message.

## Friday

### F1 — [GATE] Cat 7 — a11y fixes + re-measure (morning)
- Fix focus ring to ≥3:1, `landmark-one-main`, 21 contrast violations. Re-run `bench/cat7-a11y/` axe → `out/after-<sha>.*`; re-run `keyboard-traversal.spec.ts` (fix→measurement loop closed). Optional 10-min NVDA re-check.
- Fix [README.md:261](README.md:261)–265: false 508/WCAG-AA badges and 4.5:1 claim — grader-visible overclaim, part of the honesty workstream.
- Commits: `fix(cat7): focus ring + landmarks + contrast`, `docs: correct README accessibility claims`.

### F2 — [GATE] Cat 8 — finish Render (start Friday MORNING; external dependency)
- Mirror fork to user's GitHub (user-assisted; Render's GitHub authorization is the user's click), then in `terraform/render`: `terraform apply -var repo_url=https://github.com/<user>/shipshape`; capture numbered evidence continuing `terraform/render/out/04-…`.
- Render becomes the canonical deploy story: remove `railway.json`/`.railwayignore` (or move to `docs/attic/` with a note). Commit: `chore(deploy): Render is canonical; remove Railway config`.
- Fallback: if Render still rejects, commit the out/ evidence of the exact rejection; Cat 8 already has full terraform/local evidence.

### F3 — [GATE] Implementation rules (afternoon)
1. **`start.sh`** — one-command cold start (compose up postgres → migrate → seed → dev servers); fix README cold-start (7 manual steps, upstream clone URL, wrong port claims).
2. **`.github/workflows/ci.yml`** — build, type-check, test, coverage, `pnpm audit`, security scan (gitleaks), source/license inventory. Lint: **no eslint config exists anywhere** — bootstrap minimal flat config (`@eslint/js` + `typescript-eslint`, no stylistic rules) or document justification. Budget 1h for first-run CI flail.
3. **Dockerfile** — currently COPYs gitignored `dist/` (broken on clean checkout): build in-stage; tag artifacts with git SHA.
4. **`docs/resilience-assessment.md`** — retries/timeouts/circuit-breakers: existing primitives (`api/src/db/client.ts:20`, `web/src/lib/queryClient.ts:139`), gaps, justified decisions.
5. **`CHANGES.md`** — written last from `git log`: commit → category/finding → before/after → evidence path.
6. Regression-test gap audit (most arrive via the measurement specs + Cat-6 fixes). [POLISH] `scripts/check-empty-tests.sh` awk bug.

### F4 — [GATE] Final pass (evening, 2h buffer before 11:59)
- `pnpm -C api test`, `pnpm -C web test`, e2e smoke — all green; CI green on push.
- Final addendum table in AUDIT_REPORT.md: category | target | re-baseline | after | delta | evidence path.
- Push, tag `week4-implementation`.

---

## Commit discipline
Linear history on `main`. Per improvement: re-baseline/evidence commit → fix commit → after-capture commit. Prefixes `docs(audit)`, `test(catN)`, `perf(catN)`, `fix(catN)`, `bench:`, `ci:`, `chore(deploy)`. Every fix commit names the AUDIT_REPORT finding it addresses.

## Risks
1. 13 failing web tests gate everything — fix Wednesday night first.
2. All deltas vs Thursday re-baselines at one SHA, never vs Phase-1 prose numbers (the change-log table says why).
3. web/tsconfig 102-error flood is Thursday's schedule risk — timeboxed.
4. Render/GitHub mirror is external — start Friday morning, fallback documented.
5. NVDA is user-executed — script delivered Wednesday; results needed by Thu evening.
6. Session expiry (15 min) + rate limiter (1000/60s) can poison latency runs — pace and re-login.
7. Gitignored `*.png`/`evidence/` will eat Cat-6 screenshots — use `docs/pr-evidence/`.

## Verification
- Feedback #1 closed when: AUDIT_REPORT.md header no longer overclaims, change-log table reconciles all 8 commits, corrected lines carry dated blockquotes, Limits (incl. keyboard row) live in the report itself.
- Feedback #2 closed when: four subsections of "Post-audit measurement execution" carry real results with evidence paths (three from specs, one from the user's NVDA transcript).
- Friday gate: every category's target met with `rebaseline-<sha>` → `after-<sha>` artifact pairs under `bench/*/out/` or `terraform/*/out/`; all suites green; CI green; CHANGES.md maps commits → evidence.
