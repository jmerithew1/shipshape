/**
 * Deterministic detectors — no LLM. These gate the model: a sweep over a
 * healthy project ends here with zero candidates and zero tokens.
 *
 * Detector family: orphan_intake (the grader-provokable anchor),
 * stale_issue, stuck_review, urgent_idle, due_soon_idle (K3), week_slip —
 * all shipped; thresholds are calendar-day v1 constants below.
 *
 * Recipient resolution is deterministic (FLEETGRAPH.md §Who it notifies):
 * assignee first, then project owner_id via RACI properties.
 *
 * Week 6 (Epic 7): the SQL these rules used to inline now lives behind the
 * `ShipData` port (`ship-data.ts`), so the same rules run either against the
 * database (`PoolShipData`, unchanged Week-5 behaviour) or against Ship's own
 * public API as a first-party OAuth app (`SdkShipData`). The detectors
 * themselves are pure rule logic and no longer know which.
 *
 * Every entry point still accepts a raw `pg.Pool` and adapts it via
 * `asShipData`: the Week-5 detector tests call these functions with the pool
 * directly and are the frozen behavioural contract for this change.
 */
import type { Pool } from 'pg';
import type { CandidateFinding } from './types.js';
import { asShipData, type ShipData } from './ship-data.js';

/** Ship births every issue "Untitled" and empty — fire only after quiet. */
export const ORPHAN_GRACE_SECONDS = 90;
export const STALE_IDLE_DAYS = 3;

export async function detectOrphanIntake(
  source: ShipData | Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const data = asShipData(source);
  const rows = await data.findOrphanCandidates(workspaceId, ORPHAN_GRACE_SECONDS);

  if (rows.length === 0) return [];

  // Propose an assignee deterministically: the workspace member with the
  // lightest active load (fewest open in_progress/in_review issues). The
  // model never picks people; it only phrases the card.
  const load = await data.findLightestLoadedMember(workspaceId);
  const proposedAssignee: string | null = load?.userId ?? null;

  return rows.map((r) => ({
    detector: 'orphan_intake' as const,
    dedupKey: `orphan_intake:${r.id}`,
    workspaceId: r.workspaceId,
    projectId: r.projectId,
    documentId: r.id,
    documentTitle: r.title,
    severity: 'medium' as const,
    evidence: {
      graceSeconds: ORPHAN_GRACE_SECONDS,
      hasAssignee: false,
      hasWeek: false,
      proposedAssigneeLoad: load?.activeLoad ?? 0,
    },
    notifyUserIds: r.projectOwnerId ? [r.projectOwnerId] : [],
    ...(proposedAssignee
      ? {
          proposedAction: {
            type: 'assign_issue' as const,
            issueId: r.id,
            assigneeId: proposedAssignee,
            reason: 'lightest current active load in the workspace',
          },
        }
      : {}),
  }));
}

export async function detectStaleIssues(
  source: ShipData | Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const rows = await asShipData(source).findStaleIssues(workspaceId, STALE_IDLE_DAYS);

  return rows.map((r) => ({
    detector: 'stale_issue' as const,
    dedupKey: `stale_issue:${r.id}:${r.updatedAt.toISOString().slice(0, 10)}`,
    workspaceId: r.workspaceId,
    projectId: r.projectId,
    documentId: r.id,
    documentTitle: r.title,
    severity: 'medium' as const,
    evidence: {
      idleDays: STALE_IDLE_DAYS,
      lastActivityAt: r.updatedAt,
    },
    notifyUserIds: [r.assigneeId, r.projectOwnerId].filter(Boolean) as string[],
  }));
}

export const STUCK_REVIEW_DAYS = 2;
export const URGENT_IDLE_DAYS = 2;
export const DUE_SOON_HOURS = 48;
export const DUE_SOON_IDLE_DAYS = 1;
/** Week-slip fires when elapsed ≥ this AND done-rate trails elapsed by the gap. */
export const SLIP_MIN_ELAPSED = 0.5;
export const SLIP_GAP = 0.3;

/**
 * Stuck review: `in_review` with no activity. Reviews are where urgent work
 * quietly dies; the review state has no timestamp column, so `updated_at`
 * is the gate (same convention as detectStaleIssues) — days are calendar
 * days, v1.
 */
export async function detectStuckReview(
  source: ShipData | Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const rows = await asShipData(source).findStuckReviews(workspaceId, STUCK_REVIEW_DAYS);

  return rows.map((r) => ({
    detector: 'stuck_review' as const,
    dedupKey: `stuck_review:${r.id}:${r.updatedAt.toISOString().slice(0, 10)}`,
    workspaceId: r.workspaceId,
    projectId: r.projectId,
    documentId: r.id,
    documentTitle: r.title,
    severity: 'medium' as const,
    evidence: {
      idleDays: STUCK_REVIEW_DAYS,
      lastActivityAt: r.updatedAt,
      state: 'in_review',
    },
    notifyUserIds: [r.assigneeId, r.projectOwnerId].filter(Boolean) as string[],
  }));
}

/**
 * Urgent-but-idle: priority says drop everything; the state says nobody has.
 * Ship has no `blocked` state — this and stuck_review are the observable
 * proxies (DECISIONS.md 2026-08-03).
 */
export async function detectUrgentIdle(
  source: ShipData | Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const rows = await asShipData(source).findUrgentIdleIssues(workspaceId, URGENT_IDLE_DAYS);

  return rows.map((r) => ({
    detector: 'urgent_idle' as const,
    dedupKey: `urgent_idle:${r.id}:${r.updatedAt.toISOString().slice(0, 10)}`,
    workspaceId: r.workspaceId,
    projectId: r.projectId,
    documentId: r.id,
    documentTitle: r.title,
    severity: 'high' as const,
    evidence: {
      idleDays: URGENT_IDLE_DAYS,
      state: r.state,
      priority: 'urgent',
      lastActivityAt: r.updatedAt,
    },
    notifyUserIds: [r.assigneeId, r.projectOwnerId].filter(Boolean) as string[],
  }));
}

/**
 * Due-soon-but-idle (K3, the student-syndrome/present-bias rule): due date
 * inside 48h, no recent activity, not in a terminal state.
 */
export async function detectDueSoonIdle(
  source: ShipData | Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const rows = await asShipData(source).findDueSoonIdleIssues(
    workspaceId,
    DUE_SOON_HOURS,
    DUE_SOON_IDLE_DAYS,
  );

  return rows.map((r) => ({
    detector: 'due_soon_idle' as const,
    dedupKey: `due_soon_idle:${r.id}:${r.dueDate}`,
    workspaceId: r.workspaceId,
    projectId: r.projectId,
    documentId: r.id,
    documentTitle: r.title,
    severity: 'high' as const,
    evidence: {
      dueDate: r.dueDate,
      idleDays: DUE_SOON_IDLE_DAYS,
      lastActivityAt: r.updatedAt,
    },
    notifyUserIds: [r.assigneeId, r.projectOwnerId].filter(Boolean) as string[],
  }));
}

/**
 * Week slip: the active week (computed from workspace.sprint_start_date —
 * properties.status is a lagging signal, weeks.ts:275) is materially behind.
 * Fires when elapsed ≥ 50% AND done-rate trails elapsed by ≥ 30 points.
 * Proposal carries the not-started issues (lowest priority first) as items
 * for the per-item checkbox card (B1: card copy is loss-framed by triage).
 */
/** Cap on scope-cut checkbox items offered on a single slip card. */
export const SLIP_PROPOSAL_LIMIT = 10;

export async function detectWeekSlip(
  source: ShipData | Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const data = asShipData(source);
  const rows = await data.findActiveWeeks(workspaceId);

  const findings: CandidateFinding[] = [];
  for (const r of rows) {
    const issueCount = r.issueCount;
    if (issueCount === 0) continue;

    // Elapsed fraction of the 7-day window, UTC (weeks.ts date convention).
    const weekStart = new Date(
      r.sprintStartDate.getTime() + (r.sprintNumber - 1) * 7 * 86_400_000,
    );
    const elapsed = Math.min(1, Math.max(0, (Date.now() - weekStart.getTime()) / (7 * 86_400_000)));
    const doneRate = r.completedCount / issueCount;
    if (elapsed < SLIP_MIN_ELAPSED || doneRate >= elapsed - SLIP_GAP) continue;

    const notStarted = await data.findNotStartedWeekIssues(r.id, SLIP_PROPOSAL_LIMIT);

    findings.push({
      detector: 'week_slip' as const,
      dedupKey: `week_slip:${r.id}:${new Date().toISOString().slice(0, 10)}`,
      workspaceId: r.workspaceId,
      projectId: r.projectId,
      documentId: r.id,
      documentTitle: r.title,
      severity: 'high' as const,
      evidence: {
        elapsedPct: Math.round(elapsed * 100),
        donePct: Math.round(doneRate * 100),
        issueCount,
        completedCount: r.completedCount,
        notStartedCount: notStarted.length,
      },
      notifyUserIds: [r.weekOwnerId, r.projectOwnerId].filter(Boolean) as string[],
      ...(notStarted.length > 0
        ? {
            proposedAction: {
              type: 'move_issues_out_of_week' as const,
              weekId: r.id,
              items: notStarted.map((i) => ({
                issueId: i.id,
                title: i.title,
                state: i.state ?? '',
                priority: i.priority ?? 'none',
              })),
              reason: 'not started with the week materially behind; lowest priority first',
            },
          }
        : {}),
    });
  }
  return findings;
}

/**
 * Auto-resolve: close active findings whose condition has cleared (the card
 * disappears instead of going stale — FLEETGRAPH.md anti-noise policy).
 * Returns number of findings resolved.
 *
 * Deliberately NOT behind the `ShipData` port: this is a single correlated
 * UPDATE over `agent_findings`, the agent's own private memory. That table is
 * not a Ship resource and has no place in the public API — exposing an
 * agent's dedup state through `/api/v1` would be a category error, not a step
 * toward platform citizenship. It reads `documents` only inside EXISTS
 * subqueries of that UPDATE, which no set of REST reads can express
 * atomically.
 */
export async function autoResolveCleared(pool: Pool, workspaceId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE agent_findings af
        SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
      WHERE af.workspace_id = $1
        AND af.resolved_at IS NULL
        AND (
          (af.detector = 'orphan_intake' AND EXISTS (
            SELECT 1 FROM documents d
             WHERE d.id = af.document_id
               AND ((d.properties->>'assignee_id') IS NOT NULL
                    OR EXISTS (SELECT 1 FROM document_associations wk
                                WHERE wk.document_id = d.id
                                  AND wk.relationship_type = 'sprint')
                    OR d.properties->>'state' NOT IN ('triage', 'backlog', 'todo')
                    OR d.deleted_at IS NOT NULL OR d.archived_at IS NOT NULL)
          ))
          OR
          (af.detector = 'stale_issue' AND EXISTS (
            SELECT 1 FROM documents d
             WHERE d.id = af.document_id
               AND (d.updated_at > af.created_at
                    OR d.properties->>'state' <> 'in_progress'
                    OR d.deleted_at IS NOT NULL OR d.archived_at IS NOT NULL)
          ))
          OR
          (af.detector = 'stuck_review' AND EXISTS (
            SELECT 1 FROM documents d
             WHERE d.id = af.document_id
               AND (d.updated_at > af.created_at
                    OR d.properties->>'state' <> 'in_review'
                    OR d.deleted_at IS NOT NULL OR d.archived_at IS NOT NULL)
          ))
          OR
          (af.detector = 'urgent_idle' AND EXISTS (
            SELECT 1 FROM documents d
             WHERE d.id = af.document_id
               AND (d.updated_at > af.created_at
                    OR d.properties->>'priority' <> 'urgent'
                    OR d.properties->>'state' IN ('in_progress', 'in_review', 'done', 'cancelled')
                    OR d.deleted_at IS NOT NULL OR d.archived_at IS NOT NULL)
          ))
          OR
          (af.detector = 'due_soon_idle' AND EXISTS (
            SELECT 1 FROM documents d
             WHERE d.id = af.document_id
               AND (d.updated_at > af.created_at
                    OR d.properties->>'state' IN ('done', 'cancelled')
                    OR (d.properties->>'due_date') IS NULL
                    OR d.deleted_at IS NOT NULL OR d.archived_at IS NOT NULL)
          ))
          OR
          -- week_slip resolves when its week is no longer the active window
          -- (dedup key is date-bucketed, so a still-slipping week re-arms daily)
          (af.detector = 'week_slip' AND EXISTS (
            SELECT 1 FROM documents d
             JOIN workspaces w ON w.id = d.workspace_id
             WHERE d.id = af.document_id
               AND ((d.properties->>'sprint_number')::int <>
                    FLOOR((CURRENT_DATE - w.sprint_start_date) / 7) + 1
                    OR d.deleted_at IS NOT NULL OR d.archived_at IS NOT NULL)
          ))
        )`,
    [workspaceId],
  );
  return rowCount ?? 0;
}
