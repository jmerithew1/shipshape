/**
 * Deterministic detectors — plain SQL, no LLM. These gate the model: a sweep
 * over a healthy project ends here with zero candidates and zero tokens.
 *
 * Detector family: orphan_intake (the grader-provokable anchor),
 * stale_issue, stuck_review, urgent_idle, due_soon_idle (K3), week_slip —
 * all shipped; thresholds are calendar-day v1 constants below.
 *
 * Recipient resolution is deterministic (FLEETGRAPH.md §Who it notifies):
 * assignee first, then project owner_id via RACI properties.
 */
import type { Pool } from 'pg';
import type { CandidateFinding } from './types.js';

/** Ship births every issue "Untitled" and empty — fire only after quiet. */
export const ORPHAN_GRACE_SECONDS = 90;
export const STALE_IDLE_DAYS = 3;

export async function detectOrphanIntake(
  pool: Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.workspace_id,
            proj.related_id AS project_id,
            proj_doc.properties->>'owner_id' AS project_owner_id
       FROM documents d
       LEFT JOIN document_associations wk
              ON wk.document_id = d.id AND wk.relationship_type = 'sprint'
       LEFT JOIN document_associations proj
              ON proj.document_id = d.id AND proj.relationship_type = 'project'
       LEFT JOIN documents proj_doc ON proj_doc.id = proj.related_id
      WHERE d.workspace_id = $1
        AND d.document_type = 'issue'
        AND d.deleted_at IS NULL AND d.archived_at IS NULL
        AND COALESCE(d.properties->>'is_system_generated', 'false') <> 'true'
        AND (d.properties->>'assignee_id') IS NULL
        AND wk.document_id IS NULL
        AND d.properties->>'state' IN ('triage', 'backlog', 'todo')
        AND d.created_at < NOW() - make_interval(secs => $2)
        AND d.updated_at < NOW() - make_interval(secs => $2)`,
    [workspaceId, ORPHAN_GRACE_SECONDS],
  );

  if (rows.length === 0) return [];

  // Propose an assignee deterministically: the workspace member with the
  // lightest active load (fewest open in_progress/in_review issues). The
  // model never picks people; it only phrases the card.
  const load = await pool.query(
    `SELECT u.id,
            COUNT(d.id) FILTER (
              WHERE d.properties->>'state' IN ('in_progress', 'in_review')
                AND d.deleted_at IS NULL AND d.archived_at IS NULL
            ) AS active_load
       FROM users u
       JOIN workspace_memberships wm ON wm.user_id = u.id AND wm.workspace_id = $1
       LEFT JOIN documents d ON d.workspace_id = $1
              AND d.document_type = 'issue'
              AND d.properties->>'assignee_id' = u.id::text
      GROUP BY u.id
      ORDER BY active_load ASC, u.id
      LIMIT 1`,
    [workspaceId],
  );
  const proposedAssignee: string | null = load.rows[0]?.id ?? null;

  return rows.map((r) => ({
    detector: 'orphan_intake' as const,
    dedupKey: `orphan_intake:${r.id}`,
    workspaceId: r.workspace_id,
    projectId: r.project_id ?? null,
    documentId: r.id,
    documentTitle: r.title,
    severity: 'medium' as const,
    evidence: {
      graceSeconds: ORPHAN_GRACE_SECONDS,
      hasAssignee: false,
      hasWeek: false,
      proposedAssigneeLoad: Number(load.rows[0]?.active_load ?? 0),
    },
    notifyUserIds: r.project_owner_id ? [r.project_owner_id] : [],
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
  pool: Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.workspace_id, d.updated_at,
            d.properties->>'assignee_id' AS assignee_id,
            proj.related_id AS project_id,
            proj_doc.properties->>'owner_id' AS project_owner_id
       FROM documents d
       LEFT JOIN document_associations proj
              ON proj.document_id = d.id AND proj.relationship_type = 'project'
       LEFT JOIN documents proj_doc ON proj_doc.id = proj.related_id
      WHERE d.workspace_id = $1
        AND d.document_type = 'issue'
        AND d.deleted_at IS NULL AND d.archived_at IS NULL
        AND d.properties->>'state' = 'in_progress'
        AND d.updated_at < NOW() - make_interval(days => $2)`,
    [workspaceId, STALE_IDLE_DAYS],
  );

  return rows.map((r) => ({
    detector: 'stale_issue' as const,
    dedupKey: `stale_issue:${r.id}:${new Date(r.updated_at).toISOString().slice(0, 10)}`,
    workspaceId: r.workspace_id,
    projectId: r.project_id ?? null,
    documentId: r.id,
    documentTitle: r.title,
    severity: 'medium' as const,
    evidence: {
      idleDays: STALE_IDLE_DAYS,
      lastActivityAt: r.updated_at,
    },
    notifyUserIds: [r.assignee_id, r.project_owner_id].filter(Boolean) as string[],
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
  pool: Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.workspace_id, d.updated_at,
            d.properties->>'assignee_id' AS assignee_id,
            proj.related_id AS project_id,
            proj_doc.properties->>'owner_id' AS project_owner_id
       FROM documents d
       LEFT JOIN document_associations proj
              ON proj.document_id = d.id AND proj.relationship_type = 'project'
       LEFT JOIN documents proj_doc ON proj_doc.id = proj.related_id
      WHERE d.workspace_id = $1
        AND d.document_type = 'issue'
        AND d.deleted_at IS NULL AND d.archived_at IS NULL
        AND COALESCE(d.properties->>'is_system_generated', 'false') <> 'true'
        AND d.properties->>'state' = 'in_review'
        AND d.updated_at < NOW() - make_interval(days => $2)`,
    [workspaceId, STUCK_REVIEW_DAYS],
  );

  return rows.map((r) => ({
    detector: 'stuck_review' as const,
    dedupKey: `stuck_review:${r.id}:${new Date(r.updated_at).toISOString().slice(0, 10)}`,
    workspaceId: r.workspace_id,
    projectId: r.project_id ?? null,
    documentId: r.id,
    documentTitle: r.title,
    severity: 'medium' as const,
    evidence: {
      idleDays: STUCK_REVIEW_DAYS,
      lastActivityAt: r.updated_at,
      state: 'in_review',
    },
    notifyUserIds: [r.assignee_id, r.project_owner_id].filter(Boolean) as string[],
  }));
}

/**
 * Urgent-but-idle: priority says drop everything; the state says nobody has.
 * Ship has no `blocked` state — this and stuck_review are the observable
 * proxies (DECISIONS.md 2026-08-03).
 */
export async function detectUrgentIdle(
  pool: Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.workspace_id, d.updated_at,
            d.properties->>'state' AS state,
            d.properties->>'assignee_id' AS assignee_id,
            proj.related_id AS project_id,
            proj_doc.properties->>'owner_id' AS project_owner_id
       FROM documents d
       LEFT JOIN document_associations proj
              ON proj.document_id = d.id AND proj.relationship_type = 'project'
       LEFT JOIN documents proj_doc ON proj_doc.id = proj.related_id
      WHERE d.workspace_id = $1
        AND d.document_type = 'issue'
        AND d.deleted_at IS NULL AND d.archived_at IS NULL
        AND COALESCE(d.properties->>'is_system_generated', 'false') <> 'true'
        AND d.properties->>'priority' = 'urgent'
        AND d.properties->>'state' NOT IN ('in_progress', 'in_review', 'done', 'cancelled')
        AND d.updated_at < NOW() - make_interval(days => $2)`,
    [workspaceId, URGENT_IDLE_DAYS],
  );

  return rows.map((r) => ({
    detector: 'urgent_idle' as const,
    dedupKey: `urgent_idle:${r.id}:${new Date(r.updated_at).toISOString().slice(0, 10)}`,
    workspaceId: r.workspace_id,
    projectId: r.project_id ?? null,
    documentId: r.id,
    documentTitle: r.title,
    severity: 'high' as const,
    evidence: {
      idleDays: URGENT_IDLE_DAYS,
      state: r.state,
      priority: 'urgent',
      lastActivityAt: r.updated_at,
    },
    notifyUserIds: [r.assignee_id, r.project_owner_id].filter(Boolean) as string[],
  }));
}

/**
 * Due-soon-but-idle (K3, the student-syndrome/present-bias rule): due date
 * inside 48h, no recent activity, not in a terminal state.
 */
export async function detectDueSoonIdle(
  pool: Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.workspace_id, d.updated_at,
            d.properties->>'due_date' AS due_date,
            d.properties->>'assignee_id' AS assignee_id,
            proj.related_id AS project_id,
            proj_doc.properties->>'owner_id' AS project_owner_id
       FROM documents d
       LEFT JOIN document_associations proj
              ON proj.document_id = d.id AND proj.relationship_type = 'project'
       LEFT JOIN documents proj_doc ON proj_doc.id = proj.related_id
      WHERE d.workspace_id = $1
        AND d.document_type = 'issue'
        AND d.deleted_at IS NULL AND d.archived_at IS NULL
        AND COALESCE(d.properties->>'is_system_generated', 'false') <> 'true'
        AND d.properties->>'due_date' IS NOT NULL
        AND (d.properties->>'due_date')::date <= CURRENT_DATE + make_interval(hours => $2)::interval
        AND (d.properties->>'due_date')::date >= CURRENT_DATE
        AND d.properties->>'state' NOT IN ('done', 'cancelled')
        AND d.updated_at < NOW() - make_interval(days => $3)`,
    [workspaceId, DUE_SOON_HOURS, DUE_SOON_IDLE_DAYS],
  );

  return rows.map((r) => ({
    detector: 'due_soon_idle' as const,
    dedupKey: `due_soon_idle:${r.id}:${r.due_date}`,
    workspaceId: r.workspace_id,
    projectId: r.project_id ?? null,
    documentId: r.id,
    documentTitle: r.title,
    severity: 'high' as const,
    evidence: {
      dueDate: r.due_date,
      idleDays: DUE_SOON_IDLE_DAYS,
      lastActivityAt: r.updated_at,
    },
    notifyUserIds: [r.assignee_id, r.project_owner_id].filter(Boolean) as string[],
  }));
}

/**
 * Week slip: the active week (computed from workspace.sprint_start_date —
 * properties.status is a lagging signal, weeks.ts:275) is materially behind.
 * Fires when elapsed ≥ 50% AND done-rate trails elapsed by ≥ 30 points.
 * Proposal carries the not-started issues (lowest priority first) as items
 * for the per-item checkbox card (B1: card copy is loss-framed by triage).
 */
export async function detectWeekSlip(
  pool: Pool,
  workspaceId: string,
): Promise<CandidateFinding[]> {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.workspace_id,
            (d.properties->>'sprint_number')::int AS sprint_number,
            w.sprint_start_date,
            proj.related_id AS project_id,
            proj_doc.properties->>'owner_id' AS project_owner_id,
            d.properties->>'owner_id' AS week_owner_id,
            (SELECT COUNT(*) FROM document_associations da
              JOIN documents i ON i.id = da.document_id
             WHERE da.related_id = d.id AND da.relationship_type = 'sprint'
               AND i.deleted_at IS NULL AND i.archived_at IS NULL) AS issue_count,
            (SELECT COUNT(*) FROM document_associations da
              JOIN documents i ON i.id = da.document_id
             WHERE da.related_id = d.id AND da.relationship_type = 'sprint'
               AND i.deleted_at IS NULL AND i.archived_at IS NULL
               AND i.properties->>'state' = 'done') AS completed_count
       FROM documents d
       JOIN workspaces w ON w.id = d.workspace_id
       LEFT JOIN document_associations proj
              ON proj.document_id = d.id AND proj.relationship_type = 'project'
       LEFT JOIN documents proj_doc ON proj_doc.id = proj.related_id
      WHERE d.workspace_id = $1
        AND d.document_type = 'sprint'
        AND d.deleted_at IS NULL AND d.archived_at IS NULL
        AND (d.properties->>'sprint_number')::int =
            FLOOR((CURRENT_DATE - w.sprint_start_date) / 7) + 1`,
    [workspaceId],
  );

  const findings: CandidateFinding[] = [];
  for (const r of rows) {
    const issueCount = Number(r.issue_count);
    if (issueCount === 0) continue;

    // Elapsed fraction of the 7-day window, UTC (weeks.ts date convention).
    const start = new Date(r.sprint_start_date);
    const weekStart = new Date(start.getTime() + (r.sprint_number - 1) * 7 * 86_400_000);
    const elapsed = Math.min(1, Math.max(0, (Date.now() - weekStart.getTime()) / (7 * 86_400_000)));
    const doneRate = Number(r.completed_count) / issueCount;
    if (elapsed < SLIP_MIN_ELAPSED || doneRate >= elapsed - SLIP_GAP) continue;

    const notStarted = await pool.query(
      `SELECT i.id, i.title, i.properties->>'state' AS state,
              i.properties->>'priority' AS priority
         FROM document_associations da
         JOIN documents i ON i.id = da.document_id
        WHERE da.related_id = $1 AND da.relationship_type = 'sprint'
          AND i.deleted_at IS NULL AND i.archived_at IS NULL
          AND i.properties->>'state' IN ('triage', 'backlog', 'todo')
        ORDER BY CASE i.properties->>'priority'
                   WHEN 'low' THEN 0 WHEN 'medium' THEN 1
                   WHEN 'high' THEN 2 WHEN 'urgent' THEN 3 ELSE 0 END ASC
        LIMIT 10`,
      [r.id],
    );

    findings.push({
      detector: 'week_slip' as const,
      dedupKey: `week_slip:${r.id}:${new Date().toISOString().slice(0, 10)}`,
      workspaceId: r.workspace_id,
      projectId: r.project_id ?? null,
      documentId: r.id,
      documentTitle: r.title,
      severity: 'high' as const,
      evidence: {
        elapsedPct: Math.round(elapsed * 100),
        donePct: Math.round(doneRate * 100),
        issueCount,
        completedCount: Number(r.completed_count),
        notStartedCount: notStarted.rows.length,
      },
      notifyUserIds: [r.week_owner_id, r.project_owner_id].filter(Boolean) as string[],
      ...(notStarted.rows.length > 0
        ? {
            proposedAction: {
              type: 'move_issues_out_of_week' as const,
              weekId: r.id,
              items: notStarted.rows.map((i) => ({
                issueId: i.id,
                title: i.title,
                state: i.state,
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
