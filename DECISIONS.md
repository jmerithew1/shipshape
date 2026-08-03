# DECISIONS — running log (newest first)

Week 5 (FleetGraph) entries begin here. Each entry ends with an explicit
**Rejected:** clause so "why X over Y" is answerable under pressure.

---

## 2026-08-03 — E1 naming: no branded score name in the UI (James's call)

"Crying-wolf score" was presentation shorthand and is retired from all
user-facing material — it can read as if the *user* is being accused of
crying wolf, inverting the mechanism (the agent scores its own usefulness,
never the person). Presentation/docs name: **credibility score**; formal
name: credibility-weighted alerting. In the product UI the score has no
label at all — cards carry only the plain explainability sentence ("You've
dismissed most stale-issue nudges lately, so I only bring high-severity
ones"). **Rejected:** any gamified or judgment-flavored label visible to
users (trust score, reliability rating) — the psychology lens's
surveillance line applies to naming, not just features.

## 2026-08-03 — Enhancement gate: E1 credibility alerting adopted; game-theory kernels K1–K3; behavioral econ B1–B2 (James approved)

Differentiator research (market scan + methods scan) produced five candidate
enhancements; James adopted **E1 credibility-weighted alerting** — a
repeated-game mechanism no shipped competitor has (verified: Swarmia,
LinearB, Asana AI, Linear, Height all use static thresholds): per
(user × finding_type) discounted Beta posterior on usefulness
(α←λα+y, β←λβ+(1−y), λ=0.9), Thompson-sampled notify threshold, guards
against death spirals (decay, θ cap, critical-severity bypass, forced probe).
Schema lands in migration 038; logic lands Thu–Fri after the compliant
baseline. Seeded RNG in tests.

Ten outside game-theory proposals were adversarially reviewed against the
schema and logged decisions; three kernels survived: **K1 safe disclosure**
(self-reported slips suppress escalation and are framed as recalibration —
incentive compatibility), **K2 claim-vs-state grounding** in triage/chat
prompts (cheap talk), **K3 due-soon-idle** SQL rule inside the stale detector
family (present bias / student syndrome — uses due_date, not nonexistent git
data). Behavioral econ adds: **B1** loss-framed card copy ("3 issues won't
make Friday"), **B2** a named choice-architecture passage in FLEETGRAPH.md.

**Rejected:** E2 attention budget, E3 bootstrap slip forecast, E4 adaptive
staleness (declined at the gate — constants v1 documented as such);
dependency risk map + MPL surfacing (no issue-to-issue links —
relationship_type enum is parent/project/sprint/program, schema.sql:203 — and
no git/PR data in Ship); Free-Rider contribution scoring (individual
performance monitoring is on the deliberately-not-monitored list;
psychology-lens surveillance risk); EVI formula (unmeasurable inputs — E1 is
the implementable attention-economics gate); congestion-pricing token market
(no resource model, YAGNI, out of clock); Redis degradation cache
(contradicts Postgres-only and in-process decisions); streaks/points/social
comparison (behavioral econ shapes the agent's behavior toward people, never
scores people); Winner's Curse estimator (third documented deferral — no slip
history to calibrate on yet).

## 2026-08-03 — Cold-critic pass: five folds, all verified against the repo (Gate 2, James approved)

(1) Fix the Week-4 migration-runner defect (`migrate.ts` catch scope,
documented in `terraform/render/main.tf:56-63`) before shipping migration 038,
and make `/ready` assert agent tables exist — otherwise agent tables silently
never exist on Render. (2) Event hooks go on the create routes explicitly
(`POST /api/issues`, `POST /api/documents`, type conversion) — verified:
`logDocumentChange` never fires on creation; sweep default tightened to 2 min
(env-tunable) as graded-window backstop. (3) Orphan detection gets a 90 s
no-edit grace window (Untitled-first model births every issue orphaned) and
findings auto-resolve when the condition clears. (4) Destroy-and-redeploy
proof includes scripted repopulation (`pnpm db:seed` + demo scenario) because
`render_postgres` is in the destroy scope; tfstate gets backed up. (5) CI
fixtures keyed by graph node/intent, not request hash; the deterministic
detector gate stays inside the traced graph so quiet-path traces exist.
**Rejected:** treating the critic's findings as advisory — #1/#2/#4 fail
silently in exactly the environment where grading happens.

## 2026-08-03 — Three-lens scoping pass reshapes the build (Gate 1, James approved)

Economics: MVP anchor is orphan intake (the only grader-provokable detection);
build 5 use cases, defer accountability-gaps + daily digest — and because the
rubric requires a trace per *defined* use case (James's catch), the defined
table shrinks to the built 5, deferrals documented separately. Psychology:
artifact-not-person phrasing, forewarned escalation, one-tap "Still on it",
per-item checkboxes on multi-issue proposals, inline assignee picker,
grader-legibility (self-explanatory notification copy, heartbeat state, chat
header + suggested questions). Technology: approval cards reuse the
ActionItems dashboard surface (no notification inbox exists in Ship);
interrupt nodes side-effect-free (replay semantics); ChatAnthropic not raw
SDK; injectable model client from day one; `auto_deploy = false` + CI deploy
hook (was: deploy-on-push, contradicting our own claim).
**Rejected:** building all 7 use cases (two would be untraceable table rows);
a new bell/inbox notification UI (multi-day, zero graded benefit).

## 2026-08-03 — "Blocker" detection maps to real states, not a wished-for one

Ship's `IssueState` has no `blocked` value
(`shared/src/types/document.ts:47`). Rather than add schema for Week 5, the
blocker use case detects the two conditions the data can actually express:
stuck-in-review (> 2 business days in `in_review`) and urgent-but-idle
(`priority = urgent`, state ∉ {in_progress, in_review, done}).
**Rejected:** adding a `blocked` state via migration — schema change to a core
enum mid-sprint for one detector, when observable proxies already exist.

## 2026-08-03 — Render Starter tier (APPROVED — James, with the Gate-1 plan)

Free tier idles after inactivity, which breaks "proactive mode runs without a
user present" — node-cron does not run at all while idled, so this is
load-bearing, not a latency optimization. Starter (~$7/mo) for the week:
always-on, in-process cron just works.
**Rejected:** external cron pinger keeping free tier awake — a scheduler
propping up a scheduler; fragile and embarrassing to defend.

## 2026-08-03 — Model routing: Haiku for triage, Sonnet for chat

Triage inputs are pre-structured by deterministic detectors, so
claude-haiku-4-5 is sufficient and ~10x cheaper; chat answers need grounded
reasoning quality → claude-sonnet-5.
**Rejected:** one premium model everywhere (cost cliff at scale); one cheap
model everywhere (chat quality is the user-facing surface).

## 2026-08-03 — HITL via LangGraph interrupt() + approval cards in Ship UI

Approval is a graph node, so the gate appears in every trace; cards live in
the existing notification surface with Approve / Dismiss / Snooze; snooze
re-arms the finding's dedup key with expiry.
**Rejected:** free-text chat confirmation (unauditable, no trace artifact);
auto-apply-with-undo (mutating someone's plan and apologizing is the wrong
default for a trust-building agent).

## 2026-08-03 — Postgres for all agent state

LangGraph Postgres checkpointer for interrupt/resume; `agent_findings` for
inter-run dedup memory; `agent_runs` for cost/latency accounting. Boring
technology, already deployed, already backed up.
**Rejected:** Redis / in-memory (loses pending approvals on restart, new
infrastructure for zero graded benefit).

## 2026-08-03 — Hybrid trigger: in-process events + 5-min SQL-only sweep

Events give seconds-latency; the sweep detects what events cannot — silence
(staleness, slip, overdue artifacts). LLM sits behind the deterministic
detector stage: quiet projects cost $0 tokens at any scale.
**Rejected:** poll-only (LLM-per-poll is untenable at 1,000 projects;
detectors-only polling still wasteful vs. events for mutation-driven cases);
event-only (structurally blind to inactivity, the primary drift signal).

## 2026-08-03 — FleetGraph lives inside the Ship API service

`api/src/fleetgraph/` module in the existing Express service: direct scoped
SQL (auth-without-a-user-session dissolves into a DB pool + `agent` service
identity), in-process event bus, one Terraform-managed deploy. Module stays
isolated and extractable.
**Rejected:** separate agent service — cleaner diagram, but buys
service-to-service auth, network latency, and a second deploy pipeline for
zero graded benefit this week.

## 2026-08-03 — LangGraph.js as the graph framework

Assignment-recommended path; automatic LangSmith tracing; native
interrupt/checkpoint primitives; TypeScript matches the monorepo and shares
`shared/` types.
**Rejected:** Python LangGraph (canonical Studio support, but second runtime +
REST-only Ship access + second pipeline); hand-rolled pipeline (manual trace
instrumentation and re-implementing interrupts — all cost, no credit).
