/**
 * FleetGraph shared types.
 *
 * One graph, two doors: the trigger payload is the ONLY thing that differs
 * between proactive and on-demand runs (FLEETGRAPH.md §Graph Diagram).
 */

export type DetectorId =
  | 'orphan_intake'
  | 'stale_issue'
  | 'stuck_review'
  | 'urgent_idle'
  | 'week_slip'
  | 'due_soon_idle';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type FleetTrigger =
  | {
      kind: 'event';
      workspaceId: string;
      projectId: string | null;
      documentId: string;
      eventType: 'created' | 'changed' | 'grace_recheck';
    }
  | { kind: 'sweep'; workspaceId: string }
  | {
      kind: 'chat';
      workspaceId: string;
      userId: string;
      /** Context seed posted by the panel from the current route. */
      docType: string;
      docId: string;
      projectId?: string | null;
      weekId?: string | null;
      message: string;
    };

/** Deterministic detector output — produced by SQL rules, never by the LLM. */
export interface CandidateFinding {
  detector: DetectorId;
  dedupKey: string;
  workspaceId: string;
  projectId: string | null;
  documentId: string;
  documentTitle: string;
  severity: Severity;
  /** Structured facts the rule observed (rendered on the card as receipts). */
  evidence: Record<string, unknown>;
  /** Deterministic recipient resolution (assignee → owner → accountable). */
  notifyUserIds: string[];
  /** Allowlisted action proposal, if the detector has one (e.g. assign). */
  proposedAction?: ProposedAction;
}

/**
 * The executor allowlist. The model can only ever *propose* one of these
 * shapes; anything else is rejected deterministically. There is deliberately
 * no delete / auth / external-communication verb here.
 */
export type ProposedAction =
  | { type: 'assign_issue'; issueId: string; assigneeId: string; reason: string }
  | { type: 'post_agent_comment'; documentId: string; body: string }
  | { type: 'move_issue_out_of_week'; issueId: string; weekId: string; reason: string }
  | {
      /** Multi-item proposal for the per-item checkbox card (week slip). */
      type: 'move_issues_out_of_week';
      weekId: string;
      items: Array<{ issueId: string; title: string; state: string; priority: string }>;
      reason: string;
    };

export interface TriagedFinding extends CandidateFinding {
  title: string;
  body: string;
  /** True when the LLM was unavailable and the finding shipped rule-based. */
  ruleBasedOnly: boolean;
}

export type RunPath = 'quiet' | 'finding' | 'chat' | 'degraded' | 'error';
