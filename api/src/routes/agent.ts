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
        } | null;

        // Deterministic allowlist: the ONLY mutation this endpoint can
        // perform today is assigning an issue. Anything else is a 409.
        if (!proposal || proposal.type !== 'assign_issue' || !proposal.issueId) {
          res.status(409).json({
            error: 'This finding has no executable proposal',
          });
          return;
        }
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

      // E1 credibility evidence (schema now, thresholding Thursday):
      // engaged = approve/change/still_on_it, ignored = dismiss.
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

export default router;
