# Demo Video Script — Week 4 (~3:30)

The deliverable asks exactly three things: walk through audit findings and improvements, show
before/after measurements, explain your reasoning. This script does that and nothing else.

## Setup (5 min, before recording)

1. Visit https://ship-api-llja.onrender.com/health and wait for `{"status":"ok"}` (wakes the free tier).
2. **Window 1 — VS Code:** `AUDIT_REPORT.md` open. Find two spots so you can jump between them:
   the **Category 3** section ("The single largest cost: authentication") and the
   **"Phase-2 results summary"** table near the bottom.
3. **Window 2 — Browser, two tabs:** the live app https://ship-api-llja.onrender.com — the deployed
   database is fresh, so the seeded local accounts don't exist here: on first visit complete
   `/setup` to create an admin (throwaway credentials — staging-grade deployment), then create a
   document titled "Demo" with a line of text · the green CI run at
   https://github.com/jmerithew1/shipshape/actions (click the top run, then the checks job)
4. **Window 3 — Git Bash** in the repo, pre-typed (don't run yet):
   `node bench/cat1-types/count-types.mjs "$(pwd -W)" 2>/dev/null | head -2`

## Script

### Beat 1 — The audit findings (0:00–0:40) · VS Code, Category 3 section

> "I inherited a Treasury project-management monorepo and audited eight categories in 36 hours.
> The findings drove everything after. Two examples: every authenticated request paid a three-query
> auth tax — thirty of the main page's fifty-seven database queries, including a write to the same
> session row on every request. And ninety-two percent of the JavaScript bundle sat in one chunk,
> so even the login page downloaded the entire collaborative editor."

**Do:** have the auth-tax paragraph on screen; scroll briefly.

### Beat 2 — Improvements, before/after (0:40–2:00) · scroll to the Phase-2 results table

> "Every fix targets a named finding, and every number here is a pair of committed artifacts —
> a re-baseline and an after, at named commits. The session-write throttle and a query rewrite took
> P95 latency down twenty-four to sixty-three percent on two endpoints, and the main page from
> forty-one queries to thirty-two. Code-splitting the editor cut the initial download fifty-eight
> percent — verified on a throttled 3G connection: six hundred kilobytes down to two-forty-three.
> Accessibility went to zero critical and serious violations on the three main pages."

**Do:** move the cursor down the table rows as you name them. Then Alt+Tab to the terminal:

> "These aren't screenshots — the instruments are committed. Here's the type-safety counter live:"

**Do:** press Enter → GRAND TOTAL prints.

> "Eight-eighty-two violations, down twenty-seven percent from the re-baseline."

### Beat 3 — It runs (2:00–2:50) · Browser

**Do:** show the live app, click into a document, type a line. Switch to the CI tab, show green checks.

> "This is the deployed improved fork — one terraform apply stands it up, database and all, and the
> post-apply plan reports no drift. CI runs on every push: build, lint, strict type-check, tests
> against a real Postgres, coverage, dependency audit, and a secret scan — all green."

### Beat 4 — The reasoning (2:50–3:30) · back to VS Code, results table

> "The method mattered more than any single fix. Diagnosis before treatment: the audit ranked the
> bottlenecks, and the remediation plan ordered the work by measured impact. Identical conditions
> for every before-and-after. And when two benchmark runs disagreed, I committed both and wrote
> down why, instead of re-running until a number looked good — the failed attempts are in the repo
> next to the fix that worked, because that diagnosis is what found the real bottleneck. Everything
> I've claimed is in the repo — the reviewed snapshot under the tag week-four-implementation, the
> post-feedback closure under week-four-final — and all of it can be re-run. Thanks."

## If something breaks
- Page hangs → server asleep: hit `/health`, wait for `ok`, restart the take.
- Counter errors → `cd "C:/Users/merit/OneDrive/Desktop/shipshape"` first.
- Running long → trim Beat 1's second example.
