/**
 * Deterministic detectors — plain SQL, no LLM. These gate the model: a sweep
 * over a healthy project ends here with zero candidates and zero tokens.
 *
 * MVP detectors: orphan_intake (the grader-provokable anchor) and
 * stale_issue. stuck_review / urgent_idle / week_slip / due_soon_idle land
 * Thursday (plan step 8).
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
    },
    notifyUserIds: r.project_owner_id ? [r.project_owner_id] : [],
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
        )`,
    [workspaceId],
  );
  return rowCount ?? 0;
}
