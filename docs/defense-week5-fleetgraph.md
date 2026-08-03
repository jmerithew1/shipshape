# Week 5 Architecture Defense — FleetGraph brief

Hold this page. Everything links out: [FLEETGRAPH.md](../FLEETGRAPH.md) ·
[PRESEARCH.md](../PRESEARCH.md) · [DECISIONS.md](../DECISIONS.md) ·
speakable script: [defense-week5-script.md](defense-week5-script.md)

**Honesty frame for the whole defense:** at defense time the deliverable is a
design. No FleetGraph code is written. Say so up front — the status banner in
FLEETGRAPH.md says it in writing. What IS real: every cited Ship internal
(RACI, person docs, ActionItems surface, terraform/render), and the design has
already survived two verification passes — a three-lens scoping pass and a
blind cold-critic pass that found three silent failure modes in our own
infrastructure before a line of code was written (commit `6f527c4`,
`DECISIONS.md` top two entries). That story is a strength; tell it.

---

## 5-minute talk track (decisions-first, not a feature tour)

**Beat 1 — the jurisdiction (60s).** FleetGraph's job is project-execution
health: it watches for silence, not just events — stale issues, stuck
reviews, slipping weeks, orphaned intake. Hard autonomy boundary: additive +
attributed actions are autonomous; every mutation of a person's plan needs
their approval; delete/auth/external comms are hard-coded refusals in a
deterministic allowlist, not prompt instructions. Five use cases built and
traced; two more discovered and deliberately deferred with written rationale.

**Beat 2 — one graph, two triggers (60s).** Single LangGraph StateGraph;
proactive and on-demand differ only in trigger payload. Walk the mermaid
diagram: parallel fetch → deterministic detectors → conditional edges. Name
the quiet path out loud: a healthy project's sweep ends at `recordQuiet` with
zero LLM calls — that branch is what makes it a graph, not a pipeline, and
it's one of our two MVP trace links.

**Beat 3 — trigger model (60s).** Hybrid, and here's the argument: the most
important signals are the *absence* of events — no webhook fires when an issue
sits untouched for four days. Clock for silence, events for mutations. Because
the agent is in-process, "webhook" collapses into an event-bus emit on the
actual create/change paths — we verified the change logger never fires on
creation and hooked the create routes explicitly. Sweep is SQL-only every 2
minutes (env-tunable) as the graded-window backstop. Latency budget for the
timed test: create event → 90 s orphan grace window (Ship births every issue
"Untitled" and momentarily unassigned — firing instantly would be noise) →
30 s debounce → ~2 s SQL + 5–15 s LLM → card visible. ≈ 2–3 minutes against a
5-minute goal, and the grace window is printed on the card so it explains
itself.

**Beat 4 — cost is structural (45s).** The LLM sits *behind* the deterministic
detector stage and behind dedup memory. Quiet projects cost $0 tokens at any
project count; spend scales with findings and chat use, not with scale of
monitoring. Model routing: Haiku for triage (inputs pre-structured), Sonnet
for chat (user-facing quality). All calls through ChatAnthropic so every
token lands in LangSmith and the cost analysis is measured, not estimated.

**Beat 5 — trust surfaces (45s).** HITL is a LangGraph interrupt — the gate is
visible in the trace — surfacing as approval cards in the existing ActionItems
dashboard surface (no new inbox invented). Card anatomy is designed for trust:
evidence inline, escalation forewarned on the card, per-item checkboxes on
multi-issue proposals, and a one-tap "Still on it" that resets the clock and
notifies nobody. Findings phrase the artifact, never the person. Dedup-once +
auto-resolve when the condition clears: the surface only ever shows live
problems.

**Beat 6 — deployment reality + the de-risk story (45s).** Extends Week 4's
terraform/render. Agent identity = DB pool + `agent` service identity on
writes; "authenticate without a user session" dissolves. Then the strength
move: our own cold-critic pass caught three silent failures before build —
the Week-4 migration-runner defect that would have eaten the agent's tables on
Render, deploy-on-push contradicting our CI-gated claim (`auto_deploy=false` +
deploy hook now planned), and destroy-and-redeploy taking the database with it
(scripted repopulation is now part of the proof). Render Starter approved so
the proactive mode is actually alive with no user present.

---

## Predicted Q&A

**"Why is this a graph and not a pipeline?"** Four conditional edges, each
data-dependent: quiet-vs-triage, mutation-vs-notify, mode routing to respond,
approve-vs-dismiss after the interrupt. Different Ship states drive different
paths; the MVP trace links will be the quiet path and a finding path
side-by-side.

**"Why only 5 use cases when you found 7?"** Because the rubric requires a
trace link and regression tests per *defined* use case, the defined set must
equal the built set — no empty cells in a graded table. The two deferrals are
documented with rationale in FLEETGRAPH.md; deferral-with-reasons is discovery
evidence, not missing work.

**"Why LangGraph.js over Python — isn't Python canonical?"** It is, and we
traded Studio polish for: one language in the monorepo, shared types, direct
SQL, one deploy. The rubric wants traces (LangGraph.js traces natively) and a
diagram (Mermaid is accepted). DECISIONS.md has the rejected clause.

**"In-process? So the agent dies when the API dies."** Yes — deliberately.
Ship-down is not a partial failure we pretend to survive; sweeps resume
idempotently on restart via dedup keys, and pending approvals survive in the
Postgres checkpointer. The module is isolated in `api/src/fleetgraph/` and
extractable when scale demands it. What we bought: no service-to-service
auth, in-process events, one Terraform target.

**"What stops the LLM from doing something destructive?"** It can't reach
anything destructive. The executor validates proposed actions against a
TypeScript allowlist with no delete/auth/external verbs. Prompt injection
lands on an executor that lacks the vocabulary. Model proposes, deterministic
code disposes.

**"How do you avoid notification fatigue?"** Dedup key per condition instance;
notify once; re-notify only on severity escalation or snooze expiry; dismissal
is durable; findings auto-resolve when the condition clears. Plus "Still on
it" — clearing a false alarm costs one tap, so users don't learn to ignore
the agent. The quiet path is a designed outcome, not an accident.

**"What does a graph run cost?"** Quiet sweep: $0 (SQL only). Triage run:
~3–5k in / 0.5–1k out on Haiku. Chat turn: ~4–8k in / 0.5–1k out on Sonnet.
Real numbers land in `agent_runs` and the Cost Analysis at final — these are
pre-build estimates and I'll say so.

**"Your latency claim — prove it."** Can't yet; nothing is built. The
*budget* is: 90 s grace (orphan only) + 30 s debounce + ~2 s SQL + 5–15 s LLM
≈ 2–3 minutes against the 5-minute window, and the graded E2E test (event
introduced → card surfaced, clocked) is a required CI test, so the proof will
be a repeatable test, not a demo anecdote.

**"Graceful degradation — demonstrate it."** Design at this checkpoint:
timeout 30s / 3 retries with backoff+jitter / breaker opens after 5 failures,
half-open at 60s. Breaker-open behavior is the demo-able part once built:
detections still surface labeled "rule-based (unranked)"; chat degrades
honestly. Planned demo: point the Anthropic client at a black-hole endpoint,
run the sweep, show findings still land and nothing hangs.

**"How does chat know what I'm looking at?"** The panel posts
`{doc_type, doc_id, week_id?, project_id?}` from the current route;
`loadContext` expands via `document_associations` into the neighborhood. The
panel proves it at first paint: "Discussing: <doc title>" header + suggested
questions generated from that document. No standalone page exists to get this
wrong.

**"Who gets notified and why them?"** Deterministic table from data Ship
already has: assignee → owner on repeat → accountable for slip, via RACI
fields that already shipped (`document.ts:91-114`). No new membership model
invented.

**"Why should we believe this plan survives contact with your own codebase?"**
Because it already took two hits: a three-lens scoping pass moved the MVP
anchor and cut scope for compliance reasons, and a blind cold critic — given
only the spec — found three silent failure modes we verified against the repo
and folded in before writing code. The decision log has every rejected
alternative.

## Honesty traps (do not walk into these)

- Do **not** say "the agent detects blockers" — Ship has no `blocked` state.
  Say: stuck-in-review and urgent-but-idle, the two observable proxies
  (DECISIONS.md entry).
- Do **not** claim any latency/cost number as measured. Every number today is
  a budget or estimate; the accounting tables (`agent_runs`) are how they
  become measurements.
- Do **not** imply the accountability engine is FleetGraph. It shipped in a
  prior week; FleetGraph's accountability-gap use case is *deferred*, not
  built.
- Do **not** say "notifications" as if an inbox exists — say approval cards in
  the ActionItems surface.
- If asked anything about LangSmith specifics: keys are not yet provisioned
  (setup is the next task) — tracing is required from day one of *code*, and
  no code exists yet.

## Immediately after the defense (MVP-critical path)

Session tasks #1–#9 mirror the approved plan
(`~/.claude/plans/week-5-fleetgraph-glimmering-pinwheel.md`). First three:
1. James: LangSmith + Anthropic keys into `api/.env.local`
2. Fix migrate.ts catch scope (Day-1 prerequisite) + migration 038 +
   fleetgraph skeleton with injectable ChatAnthropic client
3. Create-path event hooks + 2-min sweep + orphan/stale detectors end-to-end
   → first two trace links
