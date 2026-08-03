# PRESEARCH — FleetGraph (Week 5)

Completed pre-search checklist. Long-form reasoning lives in `FLEETGRAPH.md`;
this file answers each prompt directly. Decisions logged in `DECISIONS.md`.

## Phase 1: Define Your Agent

### 1. Agent Responsibility Scoping

- **What events in Ship should the agent monitor proactively?** Issue lifecycle
  mutations (create, state change, assignee change), plus *absence* signals no
  event can carry: inactivity on `in_progress` issues, issues parked in
  `in_review`, urgent-but-idle work, week slip trajectory, orphaned intake,
  overdue accountability artifacts (standups/plans, via the existing
  accountability engine in `api/src/services/accountability.ts`).
- **What constitutes a condition worth surfacing?** A deterministic rule fires
  (thresholds in FLEETGRAPH.md §Agent Responsibility) AND the finding survives
  dedup against `agent_findings` memory. Known-and-notified conditions do not
  re-surface without severity escalation or snooze expiry. The quiet path is a
  first-class outcome.
- **Allowed without human approval?** Additive, attributed, in-app-only:
  findings, notifications, agent comments, digests, chat answers.
- **What must always require confirmation?** Every mutation of user documents
  (state/assignee/due date/priority/week moves/non-system issue creation) and
  any escalation beyond the project team. Enforced by a deterministic action
  allowlist in the executor, not by prompt instructions.
- **How does the agent know who is on a project?** Ship already encodes it:
  RACI fields on projects/programs (`shared/src/types/document.ts:91-114`),
  `assignee_id` on issues, `person` documents linked to users
  (`api/src/db/schema.sql:358`), workspace membership roles.
- **How does it know who to notify?** Deterministic recipient resolution table
  (FLEETGRAPH.md §Who it notifies): assignee first, project `owner_id` on
  repeat/escalation, `accountable_id` for slip risk and digests.
- **How does on-demand mode use context from the current view?** Chat panel
  posts `{doc_type, doc_id, week_id?, project_id?}` from the route;
  `loadContext` expands via `document_associations` into the document's
  neighborhood (parent project/program, active week, sibling issues, recent
  comments/activity). No standalone chat page.

### 2. Use Case Discovery (minimum 5)

Seven defined — FLEETGRAPH.md §Use Cases, each with role / trigger / detects-
produces / human-decides. Discovered from pain points the platform already
witnesses (Weeks 1–4 usage): silent stalls, stuck reviews, midweek slips
nobody names until retro, unowned intake, unlogged standups — plus the
Director rollup and the context-scoped chat. Roles covered: Director (6, 7),
PM (1, 3, 4, 5, 7), Engineer (1, 2, 7).

### 3. Trigger Model Decision

- **When does the proactive agent run without a user?** In-process event bus
  (hooks on the create routes + the `logDocumentChange` change chokepoint —
  the change logger alone never fires on creation; 30 s per-project debounce)
  + node-cron sweep, env-configurable, default every 2 minutes. Hybrid.
- **Poll vs. webhook vs. hybrid tradeoffs?** Events are blind to inactivity —
  the primary drift signal; polling alone at a 5-minute latency goal means
  aggressively sweeping everything. Hybrid gets seconds-latency on events and
  clock-based detection of silence. In-process placement makes "webhooks"
  free: no HTTP hop, no delivery failures, no webhook auth.
- **How stale is too stale?** Event-driven detections: near-real-time (orphan
  detection adds a deliberate 90 s no-edit grace window — Ship's
  Untitled-first model means every issue is born momentarily unassigned).
  Drift detections have day-scale deadlines; the 2-minute sweep is orders of
  magnitude tighter than required and exists as the graded-latency backstop.
- **Cost at 100 / 1,000 projects?** Sweep is SQL-only (~$0). The LLM sits
  behind the deterministic detector stage and dedup, so quiet projects cost
  zero tokens at any scale. Token spend scales with *findings + chat use*, not
  with project count. Full table in FLEETGRAPH.md §Trigger Model.

## Phase 2: Graph Architecture

### 4. Node Design

- **Context:** `ingestTrigger`, `loadContext`. **Fetch:** `fetchIssues`,
  `fetchWeeks`, `fetchActivity` — these three run in parallel. **Reasoning:**
  `runDetectors` (deterministic, no LLM) then `triage` (LLM). **Action:**
  `requestApproval` (interrupt), `applyAction` (allowlisted executor).
  **Output:** `notify`, `respond`, `recordQuiet`, `recordDisposition`.
- **Conditional edges:** candidates-found? (quiet vs. triage); mutation
  proposed? (approval gate vs. notify); mode? (respond for on-demand);
  human decision? (apply vs. record-disposition). Diagram in FLEETGRAPH.md.

### 5. State Management

- **Across a session:** graph state `{mode, trigger, scope, snapshot,
  findings, proposed_actions, approvals, messages}`, checkpointed to Postgres
  (LangGraph checkpointer) so interrupts survive restarts.
- **Between proactive runs:** only `agent_findings` rows (dedup key,
  disposition, severity, timestamps) — the graph is stateless between runs.
- **Avoiding redundant API calls:** no API calls — direct scoped SQL; the
  fetch stage pulls one project neighborhood, never the workspace; dedup
  prevents re-triaging known conditions (the expensive stage is skipped, not
  the cheap one).

### 6. Human-in-the-Loop Design

- **Which actions require confirmation?** All document mutations + external
  escalations (Phase 1 answer; allowlist-enforced).
- **Confirmation experience:** approval card in Ship's notification surface —
  what the agent wants to do, why (the finding), diff-style preview, Approve /
  Dismiss / Snooze buttons. Rendered where people already look, not a new
  surface.
- **Dismiss / snooze:** dismissal records disposition and suppresses that
  condition instance permanently; snooze re-arms the dedup key with an expiry
  (default 2 business days). Both resume the interrupted graph so the trace
  shows the human's decision.

### 7. Error and Failure Handling

- **Ship API down?** Not a failure domain — the agent is in-process with a DB
  pool. DB down means the whole service is down; sweeps resume idempotently on
  restart (dedup keys make re-detection safe).
- **Graceful degradation:** Anthropic calls: 30 s timeout, 3 retries with
  exponential backoff + jitter, circuit breaker (5 consecutive failures →
  open, half-open probe at 60 s). Breaker open → rule-based findings still
  surface labeled "rule-based (unranked)"; chat says it's unavailable
  honestly. LangSmith export is async fire-and-forget — observability outage
  never blocks the agent.
- **What gets cached, how long?** Project snapshot is per-run (seconds-fresh,
  no cross-run cache — correctness over cleverness); `agent_findings` is the
  only durable memory; chat neighborhoods capped and compacted per session.

## Phase 3: Stack and Deployment

### 8. Deployment Model

- **Where does the proactive agent run with no user present?** Inside the Ship
  API service on Render (terraform-managed, `terraform/render/` from Week 4);
  node-cron and the event bus live in that process.
- **Kept alive how?** Render service. Open decision: free tier idles → Starter
  (~$7/mo, always-on) recommended so the proactive guarantee holds
  (`DECISIONS.md`, needs owner sign-off).
- **Auth without a user session?** Dissolves: the agent holds a DB pool and
  acts under an `agent` service identity recorded on every write — no
  impersonation, full attribution.

### 9. Performance

- **How does the trigger model hit < 5 min detection?** Event path: emit →
  (90 s grace window for orphan) → 30 s debounce → ~2 s SQL + 5–15 s LLM →
  card visible. Expected ≈ 2–3 min for the orphan timed test, < 60 s for
  non-grace-window events. Time-based conditions bounded by the 2-min sweep.
- **Token budget per invocation:** triage ≈ 3–5k in / 0.5–1k out
  (claude-haiku-4-5); chat ≈ 4–8k in / 0.5–1k out (claude-sonnet-5). Tracked
  per-run in `agent_runs`.
- **Cost cliffs:** fetch-stage over-fetching (mitigated: scoped SQL); long
  chat histories (mitigated: neighborhood cap + compaction); LLM-in-the-sweep
  (mitigated structurally: detectors gate the LLM).
