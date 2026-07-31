# Week 4 Submission — ShipShape

## Links

| What | Where |
| --- | --- |
| Repository (submission origin) | https://labs.gauntletai.com/jamesmerithew/shipshape (branch `main`, tag `week4-implementation`) |
| GitHub mirror (CI + deploy source) | https://github.com/jmerithew1/shipshape — Actions tab shows the green CI runs |
| **Deployed application (live)** | **https://ship-api-llja.onrender.com** — full app: SPA at `/`, Swagger at `/api/docs/`, health at `/health`. Login: `dev@ship.local` / `admin123`. Free tier: first request after idle takes ~50 s to wake |
| Audit report (+ honesty amendments, measurement addendum, Phase-2 results table) | [`AUDIT_REPORT.md`](../AUDIT_REPORT.md) |
| Improvement documentation | [`CHANGES.md`](../CHANGES.md) — per-category target → result → evidence pair → rollback |
| Discovery write-up | [`DISCOVERY.md`](../DISCOVERY.md) |
| AI cost analysis | [`docs/ai-cost-analysis.md`](ai-cost-analysis.md) |
| Terraform plan review | [`terraform/local/out/01..14`](../terraform/local/out) (drift demo) · [`terraform/render/out/01..10`](../terraform/render/out) (deploy trail incl. no-drift plans) · blast-radius analysis in `AUDIT_REPORT.md` Category 8 |
| Screen-reader session | [`bench/cat7-a11y/out/nvda-session-2026-07-29.md`](../bench/cat7-a11y/out/nvda-session-2026-07-29.md) |

## Requirement → deliverable map

| Requirement | Status | Evidence |
| --- | --- | --- |
| Audit report, baselines for all categories (pass/fail gate) | ✅ | `AUDIT_REPORT.md` — plus the post-draft change log and dated corrections responding to reviewer feedback |
| Measurable improvement per category | ✅ all 8 | Phase-2 results table in `AUDIT_REPORT.md`; every number is a committed `rebaseline-<sha>` → `after-<sha>` artifact pair. Cat 3 closed on both endpoints (auth/me −47…−63%, projects −24…−38%), with the three unsuccessful attempts and the diagnosis that found the real mechanism preserved in the notes |
| Before/after proof, identical conditions | ✅ | `bench/*/out/` pairs; conditions pinned in `bench/README.md`; variance disclosed, both runs committed when they disagreed |
| Tests still pass / regression tests | ✅ | api 453/453, web 160/160, ×3 consecutive runs; regression tests per fix (throttle, extend-session, axe, keyboard, convergence) |
| CI pipeline (build, lint, types, test, coverage, audit, security scan, inventory) | ✅ | `.github/workflows/ci.yml`, green on the mirror; documented deviation: audit gates at critical (justification in `CHANGES.md`) |
| Build/release/run separation, SHA provenance | ✅ | Multi-stage `Dockerfile` (in-image build, `GIT_SHA` label); CI uploads SHA-named tarball + sha256 provenance |
| One-command local start | ✅ | `./start.sh` from a clean checkout; README cold-start rewritten |
| Retries/timeouts/circuit breakers assessment | ✅ | `docs/resilience-assessment.md` — decisions with named failure modes |
| Dev documentation | ✅ | `CHANGES.md` (what/run/test/rollback per change) |
| No cosmetic changes; commit discipline | ✅ | ~50 commits, each naming the audit finding it addresses; linear history; read it |
| Dependency pinning + lockfile | ✅ | 131 specs pinned; security floors in `pnpm-workspace.yaml` |
| Discovery write-up | ✅ | `DISCOVERY.md` |
| AI cost analysis | ✅ (spend figure owner-filled) | `docs/ai-cost-analysis.md` |
| Deployed application | ✅ | Live URL above, deployed exclusively via `terraform apply` |
| Demo video | 🎬 owner records | Outline below |
| Social post | ✍️ owner posts | Draft below |

## Response to reviewer feedback (2026-07-31)

The review passed the submission with two staff-call rows; both are closed:

| Flagged item | Closure |
| --- | --- |
| "Fifteen pre-existing end-to-end tests are still failing as mentioned in test-failure doc" | The doc (`test-failures.md`, inherited, written 2026-01-07 — six months before the audit) was reconciled against the current suite: **10 of the 15 tests no longer exist** (features/specs removed in repo history), and the **5 survivors all pass** — 103/103 across their four spec files, re-run 2026-07-31 on this host. The re-run itself required fixing the audit's second Cat-5 host defect (`spawn('npx')` in `e2e/fixtures/isolated-env.ts`). Per-test dispositions, commands, and a disclosed flake note: [`test-failures.md`](../test-failures.md) |
| "Error-handling category only has before/after transcripts for one of the three fixes; the user-facing data-loss case has a regression test but no screenshot or recording" | Every Cat-6 fix now has its own committed evidence pair: executed crash/survive transcripts for the unhandled-rejection fix, and **screenshots + screen recordings + step transcripts** for the forced-logout data-loss fix (pre-fix build vs. current build, same script, same conditions; artifacts stamp the `git hash-object` of the code they ran against). [`docs/pr-evidence/week4-cat6/`](pr-evidence/week4-cat6/README.md) |

## Demo video outline (3–5 min)

1. **The hook (30 s)** — "I inherited a Treasury project-management monorepo, audited it in 36
   hours, then had to fix what I found — and my auditors caught *me* breaking my own
   diagnose-before-treat rule." Show the Post-draft change log in AUDIT_REPORT.md.
2. **Measurement culture (60 s)** — open `bench/README.md` and one evidence pair (cat4: 41→32
   queries). Show the same command reproducing the number live. One sentence on the variance rule:
   "when two runs disagreed, I committed both."
3. **The visible wins (90 s)** — DevTools network tab on the live Render URL: initial load with
   the split bundle; then open a doc in two browser windows and type simultaneously — convergence
   live. Flash the axe spec passing (0 Critical/Serious).
4. **The honest parts (45 s)** — the parked Cat-3 endpoint with its diagnosis; the TRUNCATE
   incident and the guard it produced. "The report says what I didn't achieve, with evidence."
5. **Close (15 s)** — `terraform apply` output → "No changes" → the live health check. Tag on
   screen: `week4-implementation`.

## Social post draft (X / LinkedIn — edit voice to taste, tag @GauntletAI)

> This week I audited and improved a real U.S. Treasury project-management codebase (TypeScript
> monorepo: React, Express, Postgres, Yjs live collaboration).
>
> The part that changed how I work: my reviewers caught my audit claiming "nothing was fixed"
> while commits said otherwise. The fix wasn't spin — it was a change-log table reconciling every
> commit against every claim, and re-executing four measurements I had only reasoned about
> (including a real NVDA screen-reader session that *overturned* one of my own findings).
>
> Results, each with a committed before/after artifact: type violations −27%, initial bundle −58%
> (3G cold load 605→243 kB), main-page DB queries −22%, 0 critical/serious a11y violations on the
> core pages, 4 error-handling bugs fixed with repro transcripts — and the whole app deployed to
> Render purely via `terraform apply`.
>
> Biggest lesson: measurement discipline beats speed. When two benchmark runs disagreed, the
> honest move was committing both and writing down why. @GauntletAI

## Submission notes (paste into the submission form)

Reviewer-oriented pointers: start with `AUDIT_REPORT.md` § Post-draft change log (the response to
last week's feedback), then § Post-audit measurement execution (the four formerly-unexecuted
measurements, now run — NVDA revised one finding), then the Phase-2 results table (every claim →
artifact pair). `CHANGES.md` maps commits to evidence with rollback steps. The one intentionally
partial result (Cat 3, second endpoint) is documented with three committed fix attempts and a
diagnosis, per the "depth over breadth, proof over promises" instruction.
