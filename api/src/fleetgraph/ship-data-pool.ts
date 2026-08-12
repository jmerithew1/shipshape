/**
 * `PoolShipData` — the `ShipData` port over a raw `pg.Pool`.
 *
 * This is the flag-OFF path and it is deliberately boring: every query below
 * was MOVED here from `detectors.ts`, character for character, including the
 * DB-clock `make_interval` windows, the `COALESCE(... 'is_system_generated')`
 * exclusions and the association joins. Nothing was "improved" on the way
 * across. That is the point — with `FLEETGRAPH_VIA_SDK` unset, the agent
 * executes exactly the SQL Week 5 shipped and regression-tested, so the
 * Week-5 suite is a real proof of no-change rather than a proof that the new
 * code agrees with itself.
 *
 * The only transformation applied is row shaping: snake_case `pg` rows become
 * the port's camelCase types, and Postgres `bigint` counts (which `pg` returns
 * as strings) become numbers here instead of at each call site.
 */
import type { Pool } from 'pg';
import type {
  IssueAttribution,
  ShipActiveWeekRow,
  ShipData,
  ShipDataGaps,
  ShipDueSoonRow,
  ShipIssueRow,
  ShipMemberLoad,
  ShipOrphanRow,
  ShipUrgentIdleRow,
  ShipWeekIssueRow,
} from './ship-data.js';

/** `pg` hands back bigint as a string; every count in this file is small. */
const num = (v: unknown): number => Number(v ?? 0);

export class PoolShipData implements ShipData, ShipDataGaps {
  constructor(private readonly pool: Pool) {}

  /**
   * The v1 attribution gap, isolated to one query.
   *
   * `/api/v1` returns an issue but not the project it is associated with, not
   * that project's `owner_id`, and not `is_system_generated`. `SdkShipData`
   * calls this to fill those three fields so flag-ON findings are identical to
   * flag-OFF findings. It is the single read that keeps a pool handle alive on
   * the SDK path — see the GAP register in `ship-data-sdk.ts`.
   */
  async findIssueAttribution(issueIds: string[]): Promise<Map<string, IssueAttribution>> {
    const out = new Map<string, IssueAttribution>();
    if (issueIds.length === 0) return out;
    const { rows } = await this.pool.query(
      `SELECT d.id,
              COALESCE(d.properties->>'is_system_generated', 'false') AS is_system_generated,
              proj.related_id AS project_id,
              proj_doc.properties->>'owner_id' AS project_owner_id
         FROM documents d
         LEFT JOIN document_associations proj
                ON proj.document_id = d.id AND proj.relationship_type = 'project'
         LEFT JOIN documents proj_doc ON proj_doc.id = proj.related_id
        WHERE d.id = ANY($1)`,
      [issueIds],
    );
    for (const r of rows) {
      out.set(r.id, {
        projectId: r.project_id ?? null,
        projectOwnerId: r.project_owner_id ?? null,
        isSystemGenerated: r.is_system_generated === 'true',
      });
    }
    return out;
  }

  async findOrphanCandidates(workspaceId: string, graceSeconds: number): Promise<ShipOrphanRow[]> {
    const { rows } = await this.pool.query(
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
      [workspaceId, graceSeconds],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      workspaceId: r.workspace_id,
      projectId: r.project_id ?? null,
      projectOwnerId: r.project_owner_id ?? null,
    }));
  }

  async findLightestLoadedMember(workspaceId: string): Promise<ShipMemberLoad | null> {
    const { rows } = await this.pool.query(
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
    const row = rows[0];
    return row ? { userId: row.id, activeLoad: num(row.active_load) } : null;
  }

  async findStaleIssues(workspaceId: string, idleDays: number): Promise<ShipIssueRow[]> {
    const { rows } = await this.pool.query(
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
      [workspaceId, idleDays],
    );
    return rows.map(toIssueRow);
  }

  async findStuckReviews(workspaceId: string, idleDays: number): Promise<ShipIssueRow[]> {
    const { rows } = await this.pool.query(
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
      [workspaceId, idleDays],
    );
    return rows.map(toIssueRow);
  }

  async findUrgentIdleIssues(
    workspaceId: string,
    idleDays: number,
  ): Promise<ShipUrgentIdleRow[]> {
    const { rows } = await this.pool.query(
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
      [workspaceId, idleDays],
    );
    return rows.map((r) => ({ ...toIssueRow(r), state: r.state ?? null }));
  }

  async findDueSoonIdleIssues(
    workspaceId: string,
    dueWithinHours: number,
    idleDays: number,
  ): Promise<ShipDueSoonRow[]> {
    const { rows } = await this.pool.query(
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
      [workspaceId, dueWithinHours, idleDays],
    );
    return rows.map((r) => ({ ...toIssueRow(r), dueDate: r.due_date }));
  }

  async findActiveWeeks(workspaceId: string): Promise<ShipActiveWeekRow[]> {
    const { rows } = await this.pool.query(
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
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      workspaceId: r.workspace_id,
      sprintNumber: num(r.sprint_number),
      sprintStartDate: new Date(r.sprint_start_date),
      projectId: r.project_id ?? null,
      projectOwnerId: r.project_owner_id ?? null,
      weekOwnerId: r.week_owner_id ?? null,
      issueCount: num(r.issue_count),
      completedCount: num(r.completed_count),
    }));
  }

  async findNotStartedWeekIssues(weekId: string, limit: number): Promise<ShipWeekIssueRow[]> {
    const { rows } = await this.pool.query(
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
        LIMIT $2`,
      [weekId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      state: r.state ?? null,
      priority: r.priority ?? null,
    }));
  }
}

interface RawIssueRow {
  id: string;
  title: string;
  workspace_id: string;
  updated_at: Date;
  assignee_id: string | null;
  project_id: string | null;
  project_owner_id: string | null;
}

function toIssueRow(r: RawIssueRow): ShipIssueRow {
  return {
    id: r.id,
    title: r.title,
    workspaceId: r.workspace_id,
    updatedAt: r.updated_at,
    assigneeId: r.assignee_id ?? null,
    projectId: r.project_id ?? null,
    projectOwnerId: r.project_owner_id ?? null,
  };
}
