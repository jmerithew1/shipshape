# Remediation Plan — what to fix, in what order, and why

Companion to [`AUDIT_REPORT.md`](AUDIT_REPORT.md). The audit produced **41 findings across 8
categories**. This document does the part a findings list cannot: it collapses them into root
causes, names the small number of fixes that retire the most obligations, states what is
deliberately **not** being built, and records the limits of the evidence.

> Written during the diagnosis phase. **Nothing here has been implemented.** The brief is explicit
> that fixing happens after the audit; this is the argument for *what* to fix, not the fix.

---

## 1. How this analysis was produced

Stated first because it is what makes the rest checkable.

**Measurement.** Eight independent agents, one per audit category, each returning the rubric's exact
metric table with `file:line` evidence and an explicit brief to **measure only, fix nothing**.
Categories that share the running system (3, 4, 6, 7) were **serialised, not parallelised** — during
the audit a load test and a query count corrupted each other, and the assignment requires before/after
under identical conditions.

**Adversarial verification.** Headline claims were then re-checked by a **separate pass** whose job
was to refute them. That pass produced **five of the nine corrections**, including one finding the
auditor had backwards and one severity demotion after a second category measured the actual cost. A
wrong baseline in a pass/fail report is the worst available failure, so claims that could not be
reproduced were downgraded or dropped rather than published.

**Three-lens prioritisation.** The fix list was pressure-tested through economics, psychology and
technology lenses before any ordering was fixed. Each lens ran in parallel under hard constraints:
**at most 3 findings, ranked; answer only your own lens; do not scope the whole problem; do not write
code.** The caps exist to keep returns actionable rather than producing three essays that agree with
each other.

It changed the plan materially rather than confirming it:

| Lens | What it changed |
| --- | --- |
| **Economics** | Established that the 40% criterion is **conjunctive** — "hit the target in *all* categories" is pass/fail per category, so overshoot earns nothing. This produced the "cheapest passing route, then stop" rule and most of §4. It also caught that the entire measurement harness was sitting in a Windows `%TEMP%` directory subject to cleanup — including the seed file without which before/after would compare *different databases*. |
| **Psychology** | Found an arithmetic error in this audit's own corrections count (a nine-row table introduced as "six"), in the one sentence asserting that numbers get checked. Also argued the corrections belonged at the *top* of the report rather than line 1187 of 1232, since they are the only direct evidence a diagnostic process ran. |
| **Technology** | Identified that **fixes move each other's measurements** (§5) and that the E2E suite is a precondition for validating anything else, not one category among eight. Also killed a planned git-worktree execution model on evidence: two scripts in the repo derive the database name differently, so parallel worktrees would have measured "before" and "after" against different databases. |

**Where the lenses disagreed, both readings are recorded.** Economics rated rescuing the 869-test E2E
suite the worst available buy — same credit as three new route tests, roughly 15× the cost, against a
documented 90 GB memory explosion in the config's own history. Technology rated it load-bearing,
since 59% of the test suite is the only instrument that could detect a regression. Both are correct
from their own vantage; the synthesis in §4 (fix the blockers, do not run the full suite) is stated
with its reasoning rather than presented as consensus.

---

## 2. The 41 findings are ~5 root causes

Treating them as 41 separate problems produces 41 shallow patches. They cluster:

### RC-1 — Nothing is automatically enforced *(the meta-finding)*
Every quality property in this repo survives on individual discipline. Symptoms:

| Symptom | Evidence |
| --- | --- |
| No CI at all — deleted deliberately **twice** | `8d5c3d3`, `ac0c8ee` |
| `SECURITY.md` still claims CI provides "a second layer of enforcement" | `SECURITY.md:83` |
| No ESLint anywhere — `pnpm lint` recurses into nothing, exits 0 | all `package.json` |
| Coverage **unmeasurable** — provider absent from the lockfile | `pnpm-lock.yaml` |
| The only local gate **fails on every commit** due to a parser bug, so it is routinely bypassed | `scripts/check-empty-tests.sh:47` |
| 869 tests (59%) cannot start; 13 more fail invisibly | `isolated-env.ts:231`, `package.json:27` |

This is why the same class of defect recurs across unrelated categories: **there is no mechanism
that would have caught any of them.** Fixing enforcement is the only change that reduces the *rate*
of future findings rather than the count of current ones.

### RC-2 — Claims are not tied to the code that would back them
Not sloppiness — a pattern with a shared shape: a document asserts a property, nothing verifies it,
the property drifts, the assertion remains.

- README ships **Section 508 Compliant** + **WCAG 2.1 AA** badges; the focus ring measures **2.89:1**
  against a 3:1 requirement, and `README.md:265` claims all contrasts meet 4.5:1 while 21 live
  violations exist.
- The a11y suite cites `plans/508-accessibility-remediation.md` as its authority. **That file has
  never existed in git history.**
- `SECURITY.md` claims CI that was deleted twice.
- Two docs in `docs/` disagree about whether `program_id` is a column; the code sides with neither
  consistently.

### RC-3 — Failures are silent by construction
The system's default on error is to continue quietly. That is why several findings are severe
despite being invisible in normal operation:

- `db:migrate` applies **10 of 47** migrations and **exits 0**
- An unhandled async rejection **exits the whole process** with no log explaining why
- The audit trail — including **failed logins and admin impersonation** — fails silently
- Collaborative autosave failure leaves the editor displaying "Saved"
- 15 silent failures catalogued in Category 6

### RC-4 — Per-request work scales with request count, not data
Performance findings are not about slow queries. They are about a fixed tax:

- **3 queries on every request** including a write; **10 `UPDATE sessions` per page load**
- **53% of the main-page flow (30 of 57 queries) is authentication**
- The app shell fires 9 unconditional calls = a 48-query tax before any page renders
- Auth costs **10.1 ms — 38–61% of every endpoint's latency** before real work

### RC-5 — Tenancy and correctness are conventions, not constraints
The database enforces almost nothing; TypeScript is the only guard, and the frontend runs with
weaker checks than the backend.

- **No row-level security** — not one `CREATE POLICY` in the schema or 42 migrations
- `workspace_id = $N` is hand-written on every query; the visibility filter is **missing from 7
  route files**
- `properties JSONB` has no database-level validation at all
- **236 `req.userId!` assertions** on fields declared *optional* — each an unverified "auth ran first"
- `web/` opts out of the root's strict flags, hiding **102 errors**

---

## 3. Two fixes retire four categories between them

Cost-per-obligation is lowest here, and both are unambiguously root-cause rather than surface.

### Fix A — The auth tax *(RC-4 + RC-5)* → moves Categories 3, 4 **and** 1

One change at the middleware layer:

- **Category 3** (20% P95 on ≥2 endpoints) — auth is 38–61% of every endpoint's latency, so
  throttling the session write moves **all five measured endpoints simultaneously**, not two.
- **Category 4** (20% fewer queries on one flow) — removes ~10 of 57 queries on the main page.
  Combined with the shell fan-out, the reachable reduction is **~53%**, roughly 2.5× the target.
- **Category 1** — the same area needs an `AuthenticatedRequest` type, which deletes **236**
  non-null assertions in one mechanical change (~39% of all `!`, clearing the 25% target alone).

The throttle pattern to copy **already exists four lines below** the offending write
(`auth.ts:210`, `COOKIE_REFRESH_THRESHOLD_MS`) — the codebase already knows how to do this.

### Fix B — The migration catch-scope bug *(RC-3)* → Category 6 + the deployment story

`migrate.ts:103-111` wraps the *entire* migration loop in a `catch` intended only for `schema.sql`
re-runs, so `010_oauth_state.sql` failing with `relation "oauth_state" already exists` aborts the
loop silently and **returns exit code 0**.

Three lines. It is the audit's #1 Critical, the cleanest available demonstration of root-cause
reasoning, and a prerequisite for any honest deployment claim — `docker-compose.local.yml` advertises
that migrations run automatically on startup, and a Render deploy inherits the same lie with
`schema_migrations` reporting 10 of 47.

### Then, in order
3. **Enforcement** *(RC-1)* — CI pipeline, unblock the E2E suite, wire coverage. Highest value for
   *future* defect rate; also the precondition for trusting any other fix.
4. **Documentation honesty** *(RC-2)* — cheaper than the contrast fixes and higher trust return.
   Note that raising the focus ring to 3:1 leaves `README.md:265` false by 20 violations: the
   invisible fix and the visible claim are decoupled, and only the claim is what a reviewer reads.
5. **Category targets not covered above** — bundle (two files ≈ 19%), accessibility Critical, the
   remaining error-handling gaps.

---

## 4. Deliberately not building

Discipline is part of the plan. Each of these was considered and rejected with a reason.

| Not doing | Why |
| --- | --- |
| **Rebuilding the GIN index** | Mechanism is genuinely broken (planner refuses it even when forced, 136 ms vs 0.107 ms) but measured cost today is **0.34 ms**. A scaling landmine, not current pain. Fixing it would be optimising a number nobody feels. |
| **Route-level `React.lazy` for all 23 routes** | Overshoots the bundle target by ~3× and carries `<Suspense>` regression risk across the whole app. Two file-level fixes clear the target. |
| **Rescuing the full 869-test E2E suite** | Earns the same 5% as three new API route tests at ~15× the cost, with a documented **90 GB memory explosion** in the config's own history. Fix the blockers; do not run the full suite. |
| **`manualChunks` vendor splitting** | Measured at **0 net bytes**. Improves caching only and must not be counted toward the size target. |
| **N+1 work beyond the one flow the target requires** | Diminishing returns against a conjunctive gate where overshoot earns nothing. |
| **Removing the 245-chunk icon architecture** | A request-waterfall problem, not a size one. No category scores it. |

**Why "cheapest passing route, then stop"**: the 40% criterion is *conjunctive* — "did you hit the
target in **all** categories". Each unmet category costs ~5%; each exceeded category earns nothing
extra. Effort past a target is effort stolen from an unmet one.

---

## 5. Fixes that move each other's numbers

A sequencing hazard that would silently invalidate before/after evidence:

- **Category 4's index changes Category 3's latency.** Measuring Cat 3 "after" before Cat 4 lands
  produces a number that is neither before nor after.
- **Load testing and query counting corrupt each other** — proven during the audit, which is why
  those categories were serialised.
- **Category 1's tsconfig change surfaces 102 errors** that must be resolved before web measurements
  settle.
- **Category 5's E2E unblock gates its own measurement.**

**Therefore: "after" is a single measurement pass at the end**, re-running the exact harnesses in
[`bench/`](bench/README.md) under the stated conditions — not per-change measurement mid-flight.

---

## 6. Limits of this audit

What the evidence does **not** cover. Stated so no one over-reads it.

| Not measured | Why |
| --- | --- |
| **E2E pass/fail/flaky/runtime** | 869 tests cannot start on this host (two defects, Cat 5). Deliberately not fixed during diagnosis — "unrunnable as shipped" is itself the finding, and its before-state is worth preserving. |
| **Dependency CVEs** | No `pnpm audit` run recorded. The repo's own `comply` toolchain has its SBOM path **disabled** (`--skip-trivy`, upstream ImportError), so vulnerability scanning has never actually run here. |
| **Production-mode performance** | All latency measured against a dev server (`tsx watch`, single process, no clustering). Absolute numbers are pessimistic; **relative rankings and the c=10 saturation are the durable findings**. |
| **Load beyond 50 connections** | Saturation was already reached at 10, so higher concurrency would only measure queue depth. |
| **Cross-browser / mobile** | Playwright is chromium-only by deliberate project choice; no viewport projects exist. |
| **Authenticated Lighthouse** | Lighthouse could not carry the session cookie into the SPA's XHR; only `/login` has a valid score. axe-core was used instead on authenticated pages. |
| **Real multi-user collaboration under load** | The Yjs split-brain risk at 10× is reasoned from the code (in-process Maps, no session stickiness, `MaxSize 4`), **not** observed — it cannot be reproduced on a single instance. |
| **Concurrent two-user editing** | Not exercised with two simultaneous sessions. The CRDT-vs-last-write-wins split and the multi-instance split-brain risk are derived from the code paths (`collaboration/index.ts`, `documents.ts:484`), not observed. |
| **3G / throttled-network behaviour** | Not throttled. The 15 silent failures were found via code paths and induced API failures rather than by degrading the connection, so hanging spinners under slow networks specifically remain unmeasured. |
| **Screen-reader testing** | Not performed. The ~30 ARIA findings come from axe-core plus programmatic tab-order analysis; assistive-technology behaviour is not automatable and was out of reach here. Note this does not soften the measured accessibility findings — the 2.89:1 focus ring and 21 contrast violations stand on their own. |
| **Terraform plan against live AWS** | No credentials. `init -backend=false`, `validate`, `fmt` and `providers` all ran; blast-radius classification is static reasoning from provider ForceNew semantics and is labelled as such. |
