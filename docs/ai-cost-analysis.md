# AI Cost Analysis — Week 4

Requirement: dev spend plus a reflection on AI-tool effectiveness for codebase comprehension.
The reflection below is grounded in this repo's own commit history and evidence directories — every
claim about what the AI did or got wrong is checkable there.

## Spend

| Item | Value |
| --- | --- |
| Tooling | Claude Code (desktop app + CLI), single developer |
| Subscription / usage spend for the week | **TODO: owner fills from the billing/usage page** |
| Marginal infra spend | $0 — Render free tier (web service + postgres), GitHub free, local Docker |

## Where AI was strongly effective

- **Codebase comprehension at fan-out.** The orientation and audit phases ran parallel read-only
  analyses per subsystem/category, producing the mental model (ORIENTATION.md) and eight measured
  baselines (AUDIT_REPORT.md) far faster than serial reading could. The unified-document model,
  the auth middleware chain, and the Yjs pipeline were mapped accurately enough that later fixes
  landed without architectural surprises.
- **Measurement harness construction.** The `bench/` instruments (TS-compiler-API violation
  counter, VLQ sourcemap attributor, closed-loop load generator, pg-log query counter) and the
  four post-audit measurement specs were AI-written and are all committed, reproducible, and
  cross-checked. Turning grader feedback ("you reasoned instead of measuring") into executable
  measurements was the week's highest-leverage AI work.
- **Mechanical refactors at scale with verification.** 236 non-null assertions removed via one
  contract change; 102 strict-mode errors cleared across ~20 files by parallel agents under a
  no-new-casts rule, with the violation counter proving zero regression; 131 dependency pins.
  These are hours of error-prone human editing done in minutes, each gated by full test runs.

## Where AI was ineffective or actively costly — stated plainly

- **It caused the week's one data-loss incident.** Running `pnpm -C api test` without redirecting
  `DATABASE_URL` let the suite TRUNCATE the dev database (disclosed in
  `bench/cat3-latency/out/NOTES-2026-07-29.md`). The audit had documented this exact hazard; the
  AI hit it anyway. Recovery was fast because seeds are scripted, and the incident produced the
  permanent guard in `api/src/test/setup.ts` — but the lesson is that AI speed amplifies
  known-footgun mistakes unless guards are mechanical, not documentary.
- **Measurement noise defeated it until it stopped fighting.** Two of three latency-fix attempts
  produced no provable win because dev-mode P95 varies ±20% between identical runs; the AI's
  instinct to try "one more fix" had to be capped by explicit run bounds (max attempts, no
  re-rolling). The honest outcome — one endpoint proven, one parked with a committed diagnosis —
  was better than a lucky number would have been.
- **Environment friction consumed real time.** Windows path/cookie-scope quirks (127.0.0.1 vs
  localhost jars, MSYS path conversion), stale audit-era harness paths, and a Chrome
  accessibility-layer failure during the NVDA session each burned cycles that pure comprehension
  work would not have. AI recovered from each, but a human familiar with the machine might have
  side-stepped some outright.

## Net reflection

For *comprehension*, AI was decisively worth it: the audit's credibility rested on breadth (eight
categories measured in 36 hours) that a solo human could not have covered honestly. For
*implementation*, its value tracked how mechanical the change was and how good the surrounding
verification was — the type-contract refactor and code-splitting were near-perfect fits; latency
tuning against a noisy dev environment was the worst fit. The controlling discipline that made the
week work was not the AI's speed but the evidence rules wrapped around it: re-baseline before
fixing, commit both runs when they disagree, and never let a claim outlive its artifact.
