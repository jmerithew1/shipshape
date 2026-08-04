-- Migration 038: FleetGraph agent tables (Week 5)
--
-- Three tables for the project-intelligence agent:
-- 1. agent_findings  - detector output + dedup memory + HITL dispositions.
--    The dedup key is what makes the agent "notify once": an active finding
--    (resolved_at IS NULL) is unique per (workspace, dedup_key).
-- 2. agent_runs      - one row per graph run: cost/latency accounting that
--    feeds the Cost Analysis section of FLEETGRAPH.md at final submission.
-- 3. agent_credibility - E1 credibility-weighted alerting state: discounted
--    Beta posterior per (user, finding_type). Schema ships now; update logic
--    lands Thursday (see DECISIONS.md enhancement-gate entry).
--
-- LangGraph's PostgresSaver checkpointer manages its own tables via
-- checkpointer.setup() at boot (idempotent) - deliberately not duplicated here.

CREATE TABLE IF NOT EXISTS agent_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  detector TEXT NOT NULL CHECK (detector IN (
    'orphan_intake', 'stale_issue', 'stuck_review', 'urgent_idle',
    'week_slip', 'due_soon_idle'
  )),
  dedup_key TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open',         -- detected, card visible, no disposition yet
    'approved',     -- human approved the proposed action; executor ran it
    'changed',      -- human approved with modification (e.g. different assignee)
    'dismissed',    -- human dismissed; stays suppressed for this condition instance
    'snoozed',      -- suppressed until snooze_until, then dedup key re-arms
    'still_on_it',  -- one-tap clock reset; notifies nobody (K1 safe disclosure)
    'resolved'      -- condition cleared on its own; card auto-removed
  )),
  title TEXT NOT NULL,
  body TEXT,
  evidence JSONB NOT NULL DEFAULT '{}',
  proposed_action JSONB,
  thread_id TEXT,                -- LangGraph checkpoint thread for HITL resume
  notified_user_ids UUID[] NOT NULL DEFAULT '{}',
  snooze_until TIMESTAMPTZ,
  self_reported BOOLEAN NOT NULL DEFAULT FALSE,  -- K1: reported before detector fired
  rule_based_only BOOLEAN NOT NULL DEFAULT FALSE, -- degraded mode: LLM unavailable
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- "Notify once": only one ACTIVE finding per condition instance.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_findings_active_dedup
  ON agent_findings (workspace_id, dedup_key)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_findings_open
  ON agent_findings (workspace_id, status) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_findings_document
  ON agent_findings (document_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id UUID,
  trigger TEXT NOT NULL CHECK (trigger IN ('event', 'sweep', 'chat')),
  mode TEXT NOT NULL CHECK (mode IN ('proactive', 'on_demand')),
  path TEXT CHECK (path IN ('quiet', 'finding', 'chat', 'degraded', 'error')),
  thread_id TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  findings_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_cost ON agent_runs (model, created_at)
  WHERE input_tokens > 0;

CREATE TABLE IF NOT EXISTS agent_credibility (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  finding_type TEXT NOT NULL,
  alpha REAL NOT NULL DEFAULT 1.0,   -- discounted Beta: engaged evidence
  beta REAL NOT NULL DEFAULT 1.0,    -- discounted Beta: ignored/dismissed evidence
  last_notified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, finding_type)
);
