# Week 5 Architecture Defense — FleetGraph brief

Hold this page. Everything links out: [FLEETGRAPH.md](../FLEETGRAPH.md) ·
[PRESEARCH.md](../PRESEARCH.md) · [DECISIONS.md](../DECISIONS.md)

**Honesty frame for the whole defense:** at hour 4 the deliverable is a
design. Nothing FleetGraph-specific is built. Say so up front — the status
banner in FLEETGRAPH.md says it in writing. Cited Ship internals (RACI,
person docs, accountability engine, terraform/render) are real and shipped.

---

## 5-minute talk track (decisions-first, not a feature tour)

**Beat 1 — the jurisdiction (60s).** FleetGraph's job is project-execution
health: it watches for silence, not just events — stale issues, stuck
reviews, slipping weeks, orphaned intake, ignored accountability tasks. Hard
autonomy boundary: additive+attributed actions are autonomous; every mutation
of a person's plan needs their approval; delete/auth/external comms are
hard-coded refusals in a deterministic allowlist, not prompt instructions.

**Beat 2 — one graph, two triggers (60s).** Single LangGraph StateGraph;
proactive and on-demand differ only in trigger payload. Walk the mermaid
diagram: parallel fetch → deterministic detectors → conditional edges. Name
the quiet path out loud: a healthy project's sweep ends at `recordQuiet` with
zero LLM calls — that branch is what makes it a graph, not a pipeline, and
it's one of our two MVP trace links.

**Beat 3 — trigger model (60s).** Hybrid, and here's the argument: the most
important signals are the *absence* of events — no webhook fires when an issue
sits untouched for four days. Clock for silence, events for mutations. Because
the agent is in-process, "webhook" collapses into an event-bus emit: no HTTP,
no delivery failures. Latency budget for the graded test: emit → 30s debounce
→ ~2s SQL → 5–15s LLM → notification. Under a minute against a 5-minute goal.

**Beat 4 — cost is structural (45s).** The LLM sits *behind* the deterministic
detector stage and behind dedup memory. Quiet projects cost $0 tokens at any
project count; spend scales with findings and chat use, not with scale of
monitoring. Model routing: Haiku for triage (inputs pre-structured), Sonnet
for chat (user-facing quality).

**Beat 5 — trust surfaces (45s).** HITL is a LangGraph interrupt — the gate is
visible in the trace — surfacing as approval cards (Approve/Dismiss/Snooze) in
Ship's notification surface. Anti-noise: dedup keys mean one finding notifies
once; re-notify only on escalation or snooze expiry. Degradation: circuit
breaker on Anthropic; breaker-open still ships rule-based findings, labeled.

**Beat 6 — deployment reality (30s).** Extends Week 4's terraform/render.
Agent identity = DB pool + `agent` service identity on writes; the
"authenticate without a user session" question dissolves. Open item, stated
plainly: Render free tier idles; recommendation is Starter (~$7/mo) so the
proactive guarantee holds. Destroy-and-redeploy test will be re-run with the
agent in place.

---

## Predicted Q&A

**"Why is this a graph and not a pipeline?"** Four conditional edges, each
data-dependent: quiet-vs-triage, mutation-vs-notify, mode routing to respond,
approve-vs-dismiss after the interrupt. Different Ship states drive different
paths; the MVP trace links will be the quiet path and a finding path
side-by-side.

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
is durable. The quiet path is a designed outcome, not an accident.

**"What does a graph run cost?"** Quiet sweep: $0 (SQL only). Triage run:
~3–5k in / 0.5–1k out on Haiku. Chat turn: ~4–8k in / 0.5–1k out on Sonnet.
Real numbers land in `agent_runs` and the Cost Analysis at final — these are
pre-build estimates and I'll say so.

**"Your 5-minute latency claim — prove it."** Can't yet; nothing is built.
The *budget* is: debounce 30s + SQL ~2s + LLM 5–15s ≈ under a minute, and the
graded E2E test (event introduced → notification surfaced, clocked) is a
required CI test, so the proof will be a repeatable test, not a demo anecdote.

**"Graceful degradation — demonstrate it."** Design at this checkpoint:
timeout 30s / 3 retries with backoff+jitter / breaker opens after 5 failures,
half-open at 60s. Breaker-open behavior is the demo-able part once built:
detections still surface labeled "rule-based (unranked)"; chat degrades
honestly. Planned demo: point the Anthropic client at a black-hole endpoint,
run the sweep, show findings still land and nothing hangs.

**"How does chat know what I'm looking at?"** The panel posts
`{doc_type, doc_id, week_id?, project_id?}` from the current route;
`loadContext` expands via `document_associations` into the neighborhood. No
standalone page exists to get this wrong.

**"Who gets notified and why them?"** Deterministic table from data Ship
already has: assignee → owner on repeat → accountable for slip/digests, via
RACI fields that shipped in Week 3/4 (`document.ts:91-114`). No new
membership model invented.

## Honesty traps (do not walk into these)

- Do **not** say "the agent detects blockers" — Ship has no `blocked` state.
  Say: stuck-in-review and urgent-but-idle, the two observable proxies
  (DECISIONS.md entry).
- Do **not** claim any latency/cost number as measured. Every number today is
  a budget or estimate; the accounting tables (`agent_runs`) are how they
  become measurements.
- Do **not** imply the accountability engine is FleetGraph. It shipped in a
  prior week; FleetGraph *builds on* its outputs (use case 5).
- If asked anything about LangSmith specifics: keys are not yet provisioned
  (setup is today's next task) — tracing is required from day one of *code*,
  and no code exists yet.

## Immediately after the defense (MVP-critical path)

1. LangSmith + Anthropic keys (walkthrough ready)
2. `api/src/fleetgraph/` skeleton: state, graph, one detector (stale issue)
   end-to-end → first two trace links (quiet + finding)
3. Migration: `agent_findings`, `agent_runs` + checkpointer tables
4. Notification surface + approval card (HITL gate)
5. Render tier decision + terraform env vars, `/ready` endpoint
