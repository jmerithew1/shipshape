# CHANGES — Week-4 implementation dev docs

For the next engineer who inherits this codebase (implementation rule 8): what was added, how to
run it, how to test it, how to roll it back. Every measurable claim links to a committed artifact —
`bench/<cat>/out/rebaseline-<sha>` vs `after-<sha>` pairs, or `terraform/*/out/`, or
`docs/pr-evidence/`. Baseline conditions for every bench run: [bench/README.md](bench/README.md).

## How to run everything

| What | Command |
| --- | --- |
| Full local stack (clean checkout) | `./start.sh` — then http://localhost:5173, `dev@ship.local` / `admin123` |
| Dev servers with hot reload | `./start.sh native` (or `pnpm dev`) |
| Unit tests | `pnpm --filter @ship/api test` · `pnpm --filter @ship/web test` (api tests auto-redirect to a `ship_test` DB — see safety guard below) |
| Lint / types | `pnpm lint` · `pnpm type-check` |
| E2E measurement specs | start `pnpm dev`, then `pnpm exec playwright test e2e/<spec> --workers=1` |
| CI | `.github/workflows/ci.yml` — build, lint, type-check, test (real postgres), coverage, audit, secret scan, license inventory, SHA-tagged artifact |

## Category improvements (target → result → evidence → rollback)

### Cat 1 — Type safety (target: −25% violations)
**Result: 1,208 → 882 (−27.0%)**, both suites green, web now under full root strictness.
Commits `9f05674` (AuthenticatedRequest contract, −236 `req.*!`), `1e608ae` (checked `must()`
accessor in seed, get-or-init in team.ts, typed `queryResult()` mocks), `9cc5aeb` (web tsconfig
extends root; all 102 revealed strict errors fixed with real narrowing).
Evidence: `bench/cat1-types/out/rebaseline-8e69a59.txt` → `after-9cc5aeb.txt` (`44318b2`).
Rollback: revert the three commits in reverse order (tsconfig last).

### Cat 2 — Bundle size (target: −20% initial page load via code splitting)
**Result: initial load −58% (entry 2,025 → 808.5 kB raw); real-transfer proof −59.9% (3G cold login
605 kB → 243 kB, usable in half the time).** Commit `c22fea4` (lazy editor routes + lazy emoji
picker). Evidence: `bench/cat2-bundle/out/rebaseline-8e69a59-*` → `after-c22fea4-totals.json`,
`3g-rebaseline-0bfc3d6.json` → `3g-after-c22fea4-c22fea4.json` (`36b97f2`).
Rollback: revert `c22fea4` (static imports return; no data shape changes).

### Cat 3 — API P95 (target: −20% on ≥2 endpoints)
**Result: met on two endpoints.** `/api/auth/me`: −47%/−63% (c=10), −27%/−45% (c=25) from the
session-write throttle (`9c00675`). `/api/projects`: −31%/−38% (c=10), −24%/−27% (c=25) from
rewriting three correlated per-row subqueries (sprint/issue counts + inferred status — the audit's
slowest main-page query) as two grouped joins computed once per request; each result verified in
two consecutive runs. The route to the second endpoint matters: three earlier attempts
(`5d55ac8` N+1 batch, `b349a63` content drop) produced no provable latency win and are preserved
in `NOTES-2026-07-29.md` with the EXPLAIN-based diagnosis that ultimately pointed at the one
DB-bound endpoint.
Evidence: `bench/cat3-latency/out/` — `rebaseline-16a351b_*` → `after-*` pairs + notes.
Rollback: revert each commit independently.

### Cat 4 — Query efficiency (target: −20% query count on one flow)
**Result: main-page flow 41 → 32 queries (−22.0%).** Commit `9c00675`. Evidence:
`bench/cat4-queries/out/rebaseline-16a351b_mainpage.txt` → `after-9c00675_mainpage.txt`; flow file
committed at `bench/cat4-queries/flows/mainpage.urls` so both sides replay identical requests.
Rollback: revert `9c00675`.

### Cat 5 — Tests (target: 3 meaningful tests on untested critical paths)
**Result: the three post-audit measurement specs double as the 3 meaningful tests, each with a
risk-mitigated comment in the file:** `e2e/keyboard-traversal.spec.ts` (keyboard-only access
regressions), `e2e/collab-convergence.spec.ts` (real-time sync had zero coverage; asserts CRDT
no-loss — user data), `e2e/network-3g.spec.ts` (hanging spinners / unusable first load on slow
networks). Plus: 13 previously-failing web tests fixed with RCAs (`11142b7`, `6acd074`, `0d71006`),
3 extend-session regression tests (`22acc2f`), 2 auth-throttle regression tests (`9c00675`),
5 status-aware sprint-tab tests, and the armed axe spec (`510d520`). Suites: api 453/453,
web 160/160.
Rollback: the specs are additive; revert individual commits.

### Cat 6 — Error handling (target: 3 gaps, ≥1 user-facing data loss)
**Result: 4 gaps fixed, all with before/after repro transcripts** in
[docs/pr-evidence/week4-cat6/](docs/pr-evidence/week4-cat6/README.md): silent migration failure +
fresh-install death at 010 (`f3c89c5`), process-killing unhandled rejections (`dd98511`),
transient-network forced logout — the user-facing data-loss case (`22acc2f`), and the test suite's
unguarded TRUNCATE of whatever DATABASE_URL names (`d6e9fee` — found the hard way; incident
disclosed in `bench/cat3-latency/out/NOTES-2026-07-29.md`).
Rollback: each commit reverts independently; rollback steps in the evidence README.

### Cat 7 — Accessibility (target: all Critical/Serious axe violations on 3 key pages)
**Result: 0 Critical / 0 Serious on /login, /docs, /my-week** (from 1 critical + 13 serious nodes),
enforced by `e2e/axe-scan.spec.ts` with armed assertions; focus ring 2.89:1 → 3.78:1; keyboard
traversal re-verified 4/4 after the ring change; README's unverifiable compliance claims replaced
with measured, linkable state. Commits `4177a00`, `510d520`, `1fc2baa`. Evidence:
`bench/cat7-a11y/out/axe-rebaseline-d6e9fee.json` → `axe-after2-d6e9fee.json`.
NVDA manual protocol: `docs/nvda-session-script.md` (results recorded only as executed).
Rollback: revert `4177a00` (visual-only changes).

### Cat 8 — Terraform (target: local provider + Render deploy of the fork)
**Result: complete.** `terraform/local/` with 14-step captured evidence (init → apply → drift →
reconcile), provider pinned 2.5.2. `terraform/render/` pinned 1.9.1: project, postgres and web
service applied from the GitHub mirror (`github.com/jmerithew1/shipshape`); the **full app (API +
SPA, single service) is publicly live at https://ship-api-llja.onrender.com** — the API serves
`web/dist` (`SERVE_WEB`), the SPA calls it same-origin. Post-apply plan: "No changes. Your
infrastructure matches the configuration." Evidence trail `terraform/render/out/01..10` keeps the
history honest: the original labs.gauntletai.com rejection (02), the free-tier maintenance-mode
update quirk (08), and the `-replace` that resolved it (09–10; recreation changes the service URL).
Rollback: `terraform destroy` in terraform/render (state is local to the owner's machine).

## Infrastructure rules delivered this commit-set

- **CI** (`.github/workflows/ci.yml`): all required checks; **documented deviation** — `pnpm audit`
  gates at `--audit-level critical` (criticals fixed: vitest 4.1 bump + `pnpm-workspace.yaml`
  overrides pinning fast-xml-parser ≥5.3.5, protobufjs ≥7.5.5); the 50 pre-existing high
  advisories are transitive major-bump debt (react-router, undici, minimatch…), inventoried by the
  per-run `audit-report.json` artifact. Rollback: delete the workflow file.
- **Lint** (`eslint.config.mjs`): flat config; zero errors enforced; legacy-debt rules start as
  warnings (ratchet policy documented in the config). Previously `pnpm lint` linted nothing.
- **One-command start** (`start.sh` + README cold-start rewrite): full composed stack from a clean
  checkout; `native` and `down` modes. Rollback: delete start.sh, restore old README section.
- **Build/release/run** (`Dockerfile`): multi-stage — the image builds its own dist (previously it
  COPY'd laptop-built artifacts, breaking clean checkouts); `GIT_SHA` build-arg stamps provenance
  (OCI revision label + env). CI uploads a SHA-tagged tarball with a sha256 provenance file.
  Rollback: revert to the single-stage file.
- **Version pinning**: all 131 ranged dependency specs pinned to installed exacts across the four
  package.jsons; lockfile committed.
- **Resilience assessment** (`docs/resilience-assessment.md`): inventory of every outbound
  dependency; what was added this week (session-keepalive failure-awareness, process-level nets)
  and what was deliberately not built (DB circuit breaker — single datastore, no fallback surface),
  each with the failure mode considered.
- **Test-DB safety**: plain `pnpm test` in api/ now auto-targets `ship_test` and hard-refuses
  non-test database names.

## Known debt (tracked, not hidden)

- 339 lint warnings (ratchet baseline): `no-explicit-any` ~230, `no-unused-vars` 114, react-hooks
  v6 compiler findings including the UnifiedEditor conditional-hook cluster — real latent issues.
- 50 high transitive audit advisories (see CI deviation above).
- Cat 3's three unsuccessful latency attempts are preserved (not deleted) in
  `bench/cat3-latency/out/NOTES-2026-07-29.md` alongside the diagnosis that led to the successful
  `/api/projects` fix — kept as the record of how the mechanism was found.
- E2E full-suite run on Windows still blocked by the two Cat-5 host defects from the audit;
  measurement specs run against dev servers instead.
