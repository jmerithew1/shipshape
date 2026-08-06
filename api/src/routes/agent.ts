/**
 * FleetGraph agent routes: findings feed + disposition handling + the
 * deterministic action executor.
 *
 * The executor IS the autonomy boundary (FLEETGRAPH.md §Autonomy boundary):
 * it validates every action against the ProposedAction allowlist before
 * touching the database. There is no delete / auth / external verb here —
 * a prompt injection lands on an executor that lacks the vocabulary.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { logDocumentChange } from '../utils/document-crud.js';

type RouterType = ReturnType<typeof Router>;
const router: RouterType = Router();

/** Snooze re-arms the dedup key after this window (card copy states it). */
const SNOOZE_BUSINESS_DAYS = 2;

// GET /api/agent/findings — open findings for the caller's workspace
router.get('/findings', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT af.id, af.detector, af.severity, af.status, af.title, af.body,
              af.evidence, af.proposed_action, af.document_id, af.project_id,
              af.rule_based_only, af.created_at,
              d.title AS document_title, d.ticket_number
         FROM agent_findings af
         LEFT JOIN documents d ON d.id = af.document_id
        WHERE af.workspace_id = $1
          AND af.resolved_at IS NULL
          AND af.status IN ('open')
          AND (af.snooze_until IS NULL OR af.snooze_until < NOW())
        ORDER BY af.created_at DESC
        LIMIT 50`,
      [req.workspaceId],
    );
    res.json({ findings: rows });
  } catch (err) {
    console.error('List agent findings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const dispositionSchema = z.object({
  action: z.enum(['approve', 'change', 'dismiss', 'snooze', 'still_on_it']),
  // For 'change' on an assign proposal: the human-chosen assignee.
  assignee_id: z.string().uuid().optional(),
  // For multi-item proposals (week-slip checkbox card): the CHECKED subset.
  // Approve executes only these; unchecked items are recorded as declined.
  issue_ids: z.array(z.string().uuid()).optional(),
});

// POST /api/agent/findings/:id/disposition
router.post(
  '/findings/:id/disposition',
  authMiddleware,
  async (req: Request, res: Response) => {
    const parsed = dispositionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid disposition', details: parsed.error.issues });
      return;
    }
    const { action, assignee_id } = parsed.data;

    try {
      const { rows } = await pool.query(
        `SELECT * FROM agent_findings
          WHERE id = $1 AND workspace_id = $2 AND resolved_at IS NULL`,
        [req.params.id, req.workspaceId],
      );
      const finding = rows[0];
      if (!finding) {
        res.status(404).json({ error: 'Finding not found or already resolved' });
        return;
      }

      let executed: string | null = null;

      if (action === 'approve' || action === 'change') {
        const proposal = finding.proposed_action as {
          type?: string;
          issueId?: string;
          assigneeId?: string;
          weekId?: string;
          items?: Array<{ issueId: string; title: string }>;
        } | null;

        // Deterministic allowlist: the ONLY mutations this endpoint can
        // perform are (1) assigning an issue, (2) removing checked issues
        // from a week. Anything else is a 409 — there is no delete, auth,
        // or external verb here by design.
        if (proposal?.type === 'assign_issue' && proposal.issueId) {
          const targetAssignee = action === 'change' ? assignee_id : proposal.assigneeId;
          if (!targetAssignee) {
            res.status(400).json({ error: 'change requires assignee_id' });
            return;
          }

          const updated = await pool.query(
            `UPDATE documents
                SET properties = jsonb_set(properties, '{assignee_id}', to_jsonb($1::text)),
                    updated_at = NOW()
              WHERE id = $2 AND workspace_id = $3 AND document_type = 'issue'
                AND deleted_at IS NULL
              RETURNING id`,
            [targetAssignee, proposal.issueId, req.workspaceId],
          );
          if (updated.rowCount === 0) {
            res.status(409).json({ error: 'Target issue no longer exists' });
            return;
          }
          // Agent-attributed audit trail: the human approved, the agent acted.
          await logDocumentChange(
            proposal.issueId,
            'assignee_id',
            null,
            targetAssignee,
            req.userId!,
            'fleetgraph',
          );
          executed = `assigned to ${targetAssignee}`;
        } else if (
          proposal?.type === 'move_issues_out_of_week' &&
          proposal.weekId &&
          Array.isArray(proposal.items)
        ) {
          // Checkbox-card subset: execute ONLY ids the human checked, and
          // only ids that were actually in the proposal (allowlist within
          // the allowlist — the client cannot smuggle extra issues).
          const proposedIds = new Set(proposal.items.map((i) => i.issueId));
          const checked = (parsed.data.issue_ids ?? [...proposedIds]).filter((id) =>
            proposedIds.has(id),
          );
          if (checked.length === 0) {
            res.status(400).json({ error: 'approve requires at least one checked issue' });
            return;
          }

          const moved: string[] = [];
          for (const issueId of checked) {
            const del = await pool.query(
              `DELETE FROM document_associations da
                USING documents i
                WHERE da.document_id = $1 AND da.related_id = $2
                  AND da.relationship_type = 'sprint'
                  AND i.id = da.document_id AND i.workspace_id = $3
                RETURNING da.document_id`,
              [issueId, proposal.weekId, req.workspaceId],
            );
            if ((del.rowCount ?? 0) > 0) {
              // Precedent: weeks.ts scope-change timeline logs field='sprint_id'.
              await logDocumentChange(issueId, 'sprint_id', proposal.weekId, null, req.userId!, 'fleetgraph');
              moved.push(issueId);
            }
          }
          const declined = [...proposedIds].filter((id) => !checked.includes(id));
          await pool.query(
            `UPDATE agent_findings
                SET evidence = evidence || jsonb_build_object(
                      'movedIssueIds', $2::jsonb, 'declinedIssueIds', $3::jsonb)
              WHERE id = $1`,
            [finding.id, JSON.stringify(moved), JSON.stringify(declined)],
          );
          executed = `moved ${moved.length} issue(s) out of the week (${declined.length} declined)`;
        } else {
          res.status(409).json({ error: 'This finding has no executable proposal' });
          return;
        }
      }

      const statusByAction: Record<string, string> = {
        approve: 'approved',
        change: 'changed',
        dismiss: 'dismissed',
        snooze: 'snoozed',
        still_on_it: 'still_on_it',
      };

      await pool.query(
        `UPDATE agent_findings
            SET status = $1,
                updated_at = NOW(),
                snooze_until = CASE WHEN $1 = 'snoozed'
                  THEN NOW() + make_interval(days => $4) ELSE snooze_until END,
                resolved_at = CASE WHEN $1 IN ('approved', 'changed', 'dismissed', 'still_on_it')
                  THEN NOW() ELSE resolved_at END,
                self_reported = CASE WHEN $1 = 'still_on_it' THEN TRUE ELSE self_reported END
          WHERE id = $2 AND workspace_id = $3`,
        [statusByAction[action], finding.id, req.workspaceId, SNOOZE_BUSINESS_DAYS],
      );

      // E1 credibility evidence (gate: fleetgraph/attention.ts). Snooze
      // counts as ignored ("not useful right now") — it re-arms, so a later
      // engaged disposition recovers the score.
      const engaged = action !== 'dismiss' && action !== 'snooze';
      await pool.query(
        `INSERT INTO agent_credibility (user_id, finding_type, alpha, beta)
         VALUES ($1, $2, 1.0 + $3::int, 1.0 + $4::int)
         ON CONFLICT (user_id, finding_type) DO UPDATE
           SET alpha = 0.9 * agent_credibility.alpha + $3::int,
               beta  = 0.9 * agent_credibility.beta  + $4::int,
               updated_at = NOW()`,
        [req.userId, finding.detector, engaged ? 1 : 0, engaged ? 0 : 1],
      );

      res.json({ ok: true, status: statusByAction[action], executed });
    } catch (err) {
      console.error('Agent disposition error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

const chatSchema = z.object({
  doc_type: z.string().min(1),
  doc_id: z.string().uuid(),
  project_id: z.string().uuid().nullable().optional(),
  week_id: z.string().uuid().nullable().optional(),
  message: z.string().min(1).max(4000),
});

// POST /api/agent/chat — on-demand door. Context-scoped: the panel posts
// what the user is looking at; the graph reasons from that neighborhood.
router.post('/chat', authMiddleware, async (req: Request, res: Response) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid chat request', details: parsed.error.issues });
    return;
  }
  try {
    const { getFleetRuntime } = await import('../fleetgraph/index.js');
    const runtime = getFleetRuntime();
    if (!runtime) {
      res.status(503).json({ error: 'FleetGraph is not initialized' });
      return;
    }
    const result = await runtime.runTrigger({
      kind: 'chat',
      workspaceId: req.workspaceId!,
      userId: req.userId!,
      docType: parsed.data.doc_type,
      docId: parsed.data.doc_id,
      projectId: parsed.data.project_id ?? null,
      weekId: parsed.data.week_id ?? null,
      message: parsed.data.message,
    });
    res.json({
      response:
        result.chatResponse ??
        "FleetGraph couldn't produce an answer for this request.",
      degraded: result.path === 'degraded',
    });
  } catch (err) {
    console.error('Agent chat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
