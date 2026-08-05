# Week-4 Improvements — Consolidated Report

This document consolidates the Week-4 improvement work into a single top-to-bottom read: every category's before number, root cause, fix, after number measured under identical conditions, the regression test that locks it, and the rollback step. The standard applied throughout is *before → root cause → fix → after (identical conditions) → regression test → rollback*, with every measurable claim backed by a committed evidence pair (`bench/<cat>/out/rebaseline-*` → `after-*`, `terraform/*/out/`, or `pr-evidence/week4-cat6/`). This file is a consolidation, not a replacement — the per-file sources remain the primary artifacts and are linked throughout: [CHANGES.md](../CHANGES.md), [AUDIT_REPORT.md](../AUDIT_REPORT.md) (Phase-2 results table + post-draft change log), [pr-evidence/week4-cat6/README.md](pr-evidence/week4-cat6/README.md), [DISCOVERY.md](../DISCOVERY.md), and [test-failures.md](../test-failures.md).

## Summary table

| Cat | Category | Before → After | Evidence | Rollback |
| --- | --- | --- | --- | --- |
| 1 | Type safety | 1,208 → 882 violations (**−27.0%**, target −25%) | `bench/cat1-types/out/rebaseline-8e69a59.txt` → `after-9cc5aeb.txt` | Revert `9f05674`, `1e608ae`, `9cc5aeb` in reverse order |
| 2 | Bundle size | Entry 2,025 → 808.5 kB (**−58%**); 3G cold login 605 → 243 kB (**−59.9%**), usable 7.2 s → 3.7 s | `bench/cat2-bundle/out/` rebaseline/after + 3G pair | Revert `c22fea4` |
| 3 | API P95 | `/api/auth/me` **−47..−63% / −27..−45%**; `/api/projects` **−31..−38% / −24..−27%** (c=10/c=25) | `bench/cat3-latency/out/` pairs + `NOTES-2026-07-29.md` | Revert `9c00675` / projects-rewrite commit independently |
| 4 | Query count | Main-page flow 41 → 32 queries (**−22.0%**) | `bench/cat4-queries/out/rebaseline-16a351b_mainpage.txt` → `after-9c00675_mainpage.txt` | Revert `9c00675` |
| 5 | Tests | 3 untested critical paths → 3 assertive specs + 13 RCA'd fixes + regression tests; api 453/453, web 160/160 | `e2e/{keyboard-traversal,collab-convergence,network-3g}.spec.ts` | Additive — revert individual commits |
| 6 | Error handling | 3 rubric gaps + 1 bonus, all fixed with before/after pairs | [pr-evidence/week4-cat6/](pr-evidence/week4-cat6/README.md) | Each commit reverts independently |
| 7 | Accessibility | 1 Critical + 13 Serious nodes → **0/0** on /login, /docs, /my-week; focus ring 2.89:1 → 3.78:1 | `bench/cat7-a11y/out/axe-rebaseline-d6e9fee.json` → `axe-after2-d6e9fee.json` | Revert `4177a00` (visual-only) |
| 8 | Terraform | No IaC → local provider (14-step evidence) + Render deploy, app live (Week-4 URL: ship-api-llja; the service has since been recreated from config alone during Week 5's destroy-and-redeploy proof — current URL in `docs/submission-week5.md`) | `terraform/local/out/01..14`, `terraform/render/out/01..14` | `terraform destroy` in terraform/render |

Authoritative numbers: the [Phase-2 results summary in AUDIT_REPORT.md](../AUDIT_REPORT.md) and the per-category entries in [CHANGES.md](../CHANGES.md).

### Cat 1 — Type safety (target −25% violations)

Baseline: 1,208 violations; web was not under root strictness at all. Root cause split three ways: unchecked `req.*!` assertions (fixed by an `AuthenticatedRequest` contract, `9f05674`, −236), an inference dead-end in test mocks (`1e608ae` — see the callback-API insight in [DISCOVERY.md](../DISCOVERY.md)), and web's tsconfig not extending root (`9cc5aeb` — all 102 revealed strict errors fixed with real narrowing, no suppressions). After: **882 (−27.0%)**, both suites green. Locked by CI type-check on every push. Evidence: `bench/cat1-types/out/rebaseline-8e69a59.txt` → `after-9cc5aeb.txt`. Rollback: revert the three commits in reverse order (tsconfig last).

### Cat 2 — Bundle size (target −20% initial load)

Baseline: entry chunk 2,025 kB; 3G cold login transferred 605 kB, usable at 7.2 s. Root cause: editor-carrying routes imported statically, and `EmojiPicker`'s runtime `Theme` enum import pinned 266.7 kB of `emoji-picker-react` into the entry graph even after `React.lazy` (code splitting is a module-graph property — [DISCOVERY.md](../DISCOVERY.md) item 3). Fix: lazy editor routes + `import type` conversion (`c22fea4`). After: entry 808.5 kB (**−58%**); real-transfer proof 243 kB, usable 3.7 s (**−59.9%**). Locked by `e2e/network-3g.spec.ts`. Evidence: `bench/cat2-bundle/out/rebaseline-8e69a59-*` → `after-c22fea4-totals.json` and the `3g-*` pair. Rollback: revert `c22fea4` (no data-shape changes).

### Cat 3 — API P95 latency (target −20% on ≥2 endpoints)

Baseline (P95): `/api/auth/me` 93.7/127.4 ms, `/api/projects` 106.6/236.2 ms (c=10/c=25). Root causes: a session write on every authenticated request (fixed by the session-write throttle, `9c00675`), and three correlated per-row subqueries on the audit's slowest main-page query (rewritten as two grouped joins computed once per request). After: auth/me **−47..−63% / −27..−45%**; projects **−31..−38% / −24..−27%**, each verified in two consecutive runs. Locked by 2 auth-throttle regression tests (`9c00675`). Three earlier attempts (incl. `5d55ac8` N+1 batch, `b349a63` content drop) produced no provable win — preserved with the EXPLAIN diagnosis in `bench/cat3-latency/out/NOTES-2026-07-29.md` (see Dead ends below). Evidence: `bench/cat3-latency/out/rebaseline-16a351b_*` → `after-*` pairs. Rollback: revert each commit independently.

### Cat 4 — Query efficiency (target −20% on one flow)

Baseline: main-page flow issued 41 queries. Root cause: the same per-request session write and redundant per-row lookups identified in Cat 3. Fix: `9c00675`. After: **32 queries (−22.0%)**, replayed against the identical committed flow file (`bench/cat4-queries/flows/mainpage.urls`) so both sides issue the same requests. Evidence: `bench/cat4-queries/out/rebaseline-16a351b_mainpage.txt` → `after-9c00675_mainpage.txt`. Rollback: revert `9c00675`.

### Cat 5 — Tests (target: 3 meaningful tests on untested critical paths)

Baseline: real-time sync, keyboard-only access, and slow-network behavior had **zero coverage**; the E2E suite could not run on this Windows host at all (two repo defects, both since fixed — see [test-failures.md](../test-failures.md)). The three post-audit measurement specs double as the 3 meaningful tests, each with a risk-mitigated comment in-file: `e2e/keyboard-traversal.spec.ts`, `e2e/collab-convergence.spec.ts` (asserts CRDT no-character-loss — user data), `e2e/network-3g.spec.ts`. Plus 13 previously-failing web tests fixed with RCAs (`11142b7`, `6acd074`, `0d71006`), 3 extend-session regression tests (`22acc2f`), 2 auth-throttle tests (`9c00675`), 5 status-aware sprint-tab tests, and the armed axe spec (`510d520`). Suites: **api 453/453, web 160/160**. Rollback: additive — revert individual commits.

### Cat 6 — Error handling (target: 3 gaps, ≥1 user-facing data loss)

Four gaps fixed; full repro steps, transcripts, and provenance (each artifact records the `git hash-object` of the source it ran against) in [pr-evidence/week4-cat6/README.md](pr-evidence/week4-cat6/README.md).

1. **Silent migration failure** (`f3c89c5`): migrations failed with exit 0 — fresh installs died at `010_oauth_state.sql` while the deploy proceeded against a half-migrated database. Root causes: an over-broad "already exists" catch (now scoped to schema.sql only) and fresh installs re-executing migrations atop the schema.sql snapshot (now detected and baseline-stamped). After: fresh install stamps all migrations, exit 0; a broken migration names the file, rolls back, exits 1. Pairs: `before/after-fresh-install.txt`, `before/after-broken-migration.txt`.
2. **Process-killing unhandled rejections** (`dd98511`): no `unhandledRejection` handler existed anywhere in `api/src`; one un-awaited rejection killed the API for every user. Fix: process-level handlers (log loudly and keep serving; `uncaughtException` exits non-zero for supervisor restart). Executed pair: `before/after-unhandled-rejection.txt` produced by the committed `repro-unhandled-rejection.{ts,sh}` — before: crash, exit 1, `/health` dead; after: logged, `/health` 200 at +2 s and +6 s.
3. **Transient-network forced logout — the user-facing data-loss case** (`22acc2f`): `useSessionTimeout.resetTimer` treated *any* "Stay logged in" failure — including a one-second wifi blip — as session death and dumped the user to /login. Fix: only 401/403 logs out; transient failures warn and retry on the next cycle. Locked by 3 unit tests (500 → no logout, network error → no logout, 401 → logout); web 160/160.
4. **Bonus — unguarded test TRUNCATE** (`d6e9fee`): found the hard way (see Dead ends). `api/vitest.config.ts` now redirects non-test DATABASE_URLs to `ship_test`; `api/src/test/setup.ts` hard-refuses non-test database names. Deliberately no executed "before" (that would truncate a live database); evidence is the disclosed incident + guard code.

**Visual evidence set (complete as of 2026-08-04):** all three rubric gaps now carry screenshots and screen recordings in `pr-evidence/week4-cat6/` — Gap 1: `migrate-{before,after}.webm` + PNGs; Gap 2: `rejection-{before,after}.webm` + PNGs; Gap 3: `extend-session-*.webm` + PNGs (before: dumped to `/login?expired=true` while the session was still alive server-side; after: still on /docs, modal dismissed, session kept). Rollback: each commit reverts independently; per-fix steps in the evidence README.

### Cat 7 — Accessibility (target: 0 Critical/Serious axe violations on 3 key pages)

Baseline: 1 Critical + 13 Serious nodes across /login, /docs, /my-week; focus ring contrast 2.89:1. Fixes in `4177a00`, `510d520`, `1fc2baa`. After: **0 Critical / 0 Serious** on all three pages; focus ring 3.78:1; keyboard traversal re-verified 4/4 after the ring change; README's unverifiable compliance claims replaced with measured state. Locked by `e2e/axe-scan.spec.ts` with armed assertions (regressions fail the run). NVDA manual protocol executed by the repository owner 2026-07-30: 13 pass / 2 partial / 0 fail (`nvda-session-script.md`, [AUDIT_REPORT.md](../AUDIT_REPORT.md) addendum). Evidence: `bench/cat7-a11y/out/axe-rebaseline-d6e9fee.json` → `axe-after2-d6e9fee.json`. Rollback: revert `4177a00` (visual-only changes).

### Cat 8 — Terraform (target: local provider + Render deploy of the fork)

Baseline: no IaC (audit found both required providers fully greenfield). Delivered: `terraform/local/` (provider pinned 2.5.2) with 14-step captured evidence — init → apply → drift → reconcile; `terraform/render/` (pinned 1.9.1) applying project, postgres, and web service from the GitHub mirror (`github.com/jmerithew1/shipshape`). The **full app (API + SPA, single service) is publicly live at https://ship-api-llja.onrender.com**; post-apply plan: "No changes. Your infrastructure matches the configuration." The evidence trail `terraform/render/out/01..10` keeps the history honest: the labs.gauntletai.com rejection (02), the free-tier maintenance-mode quirk (08), and the `-replace` that resolved it (09–10). Rollback: `terraform destroy` in terraform/render (state is local to the owner's machine).

## Dead ends, preserved

- **Cat 3's three failed latency attempts** (incl. `5d55ac8` N+1 batch, `b349a63` content drop) produced no provable P95 win. They are kept — not deleted — in `bench/cat3-latency/out/NOTES-2026-07-29.md`, alongside the EXPLAIN-based diagnosis that identified `/api/projects` as the one DB-bound endpoint and led directly to the successful grouped-join rewrite. Kept as the record of how the mechanism was found ([CHANGES.md](../CHANGES.md), Known debt).
- **The TRUNCATE incident** (2026-07-29): running `pnpm -C api test` with `.env.local`'s DATABASE_URL wiped `ship_dev`. The database was restored to exact pinned conditions, the incident disclosed in the same notes file, and the guard shipped as Cat 6's fourth fix (`d6e9fee`) — verified with `ship_dev` untouched at 557 documents before and after ([pr-evidence/week4-cat6/README.md](pr-evidence/week4-cat6/README.md)).
- **The audit's own process failure** is disclosed rather than edited away: eight non-documentation commits landed before the report was reconciled with them; the [post-draft change log](../AUDIT_REPORT.md) reconciles every one, and all Phase-2 deltas are anchored to fresh re-baselines at a single post-change HEAD — never audit-window prose.
- **Inherited test-failures.md** claimed 15 failing E2E tests; the 2026-07-31 reconciliation found 10 no longer exist and the 5 survivors all pass (103/103 across their four spec files), with one host-load flake disclosed — see [test-failures.md](../test-failures.md).

## Reading order for graders

1. This file, top to bottom — every claim links onward to its source.
2. [AUDIT_REPORT.md](../AUDIT_REPORT.md) — Phase-2 results table (bottom) and the post-draft change log (top) for how baselines were kept honest.
3. [CHANGES.md](../CHANGES.md) — per-category narrative, infrastructure rules, and known debt.
4. [pr-evidence/week4-cat6/README.md](pr-evidence/week4-cat6/README.md) — the deepest single evidence set: repro scripts, transcripts, recordings, provenance hashes.
5. [DISCOVERY.md](../DISCOVERY.md) and [test-failures.md](../test-failures.md) — the three discovery write-ups and the inherited-failures reconciliation.
