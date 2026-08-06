/**
 * FleetGraph disposition-route regression tests — supertest through the real
 * Express app (session + CSRF, e2e-modes house style) against ship_test.
 *
 * Findings are seeded directly into agent_findings (the route's contract is
 * the row + proposal shape, not the detector pipeline), issues/weeks are real
 * documents rows, and every assertion checks the database side effects the
 * executor is allowed to make: assignee set, sprint association deleted,
 * history rows attributed to fleetgraph, credibility Beta updated with the
 * 0.9 discount.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';

describe('FleetGraph agent routes (dispositions + findings feed)', () => {
  const app = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let sessionCookie: string;
  let csrfToken: string;
  let workspaceId: string;
  let userId: string; // the session user (dispositions are attributed to them)
  let memberId: string; // a second member: the proposal's assignment target

  async function seedIssue(title: string, properties: Record<string, unknown> = {}): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by, properties)
       VALUES ($1, 'issue', $2, 'workspace', $3, $4) RETURNING id`,
      [workspaceId, `${title} ${testRunId}`, userId, JSON.stringify({ state: 'todo', ...properties })],
    );
    return rows[0].id;
  }

  async function seedWeekWithIssues(title: string, issueIds: string[]): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, properties)
       VALUES ($1, 'sprint', $2, 'workspace', $3) RETURNING id`,
      [workspaceId, `${title} ${testRunId}`, JSON.stringify({ sprint_number: 1 })],
    );
    const weekId: string = rows[0].id;
    for (const issueId of issueIds) {
      await pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type)
         VALUES ($1, $2, 'sprint')`,
        [issueId, weekId],
      );
    }
    return weekId;
  }

  async function insertFinding(opts: {
    detector: string;
    documentId?: string | null;
    proposedAction?: unknown;
    severity?: string;
    status?: string;
    snoozeHours?: number;
    resolved?: boolean;
  }): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO agent_findings
         (workspace_id, document_id, detector, dedup_key, severity, status, title,
          proposed_action, snooze_until, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'test finding', $7,
               CASE WHEN $8::int IS NULL THEN NULL
                    ELSE NOW() + make_interval(hours => $8::int) END,
               CASE WHEN $9::boolean THEN NOW() ELSE NULL END)
       RETURNING id`,
      [
        workspaceId,
        opts.documentId ?? null,
        opts.detector,
        `${opts.detector}:${crypto.randomUUID()}`,
        opts.severity ?? 'medium',
        opts.status ?? 'open',
        opts.proposedAction ? JSON.stringify(opts.proposedAction) : null,
        opts.snoozeHours ?? null,
        opts.resolved ?? false,
      ],
    );
    return rows[0].id;
  }

  const postDisposition = (findingId: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/agent/findings/${findingId}/disposition`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send(body);

  const getFinding = async (findingId: string) => {
    const { rows } = await pool.query(`SELECT * FROM agent_findings WHERE id = $1`, [findingId]);
    return rows[0];
  };

  beforeAll(async () => {
    process.env.FLEETGRAPH_ENABLED = 'false';

    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `Agent route ${testRunId}`,
    ]);
    workspaceId = ws.rows[0].id;

    const mkUser = async (label: string) => {
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, 'test-hash', $2) RETURNING id`,
        [`agent-route-${label}-${testRunId}@ship.local`, `Agent Route ${label}`],
      );
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [workspaceId, rows[0].id],
      );
      return rows[0].id as string;
    };
    userId = await mkUser('caller');
    memberId = await mkUser('assignee');

    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, userId, workspaceId],
    );
    sessionCookie = `session_id=${sessionId}`;

    const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie);
    csrfToken = csrfRes.body.token;
    const connectSidCookie = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
    if (connectSidCookie) {
      sessionCookie = `${sessionCookie}; ${connectSidCookie}`;
    }
  });

  afterAll(async () => {
    if (workspaceId) {
      // agent_* tables are not truncated by setup.ts — clean our rows here.
      await pool.query(`DELETE FROM agent_findings WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM agent_credibility WHERE user_id = ANY($1)`, [[userId, memberId]]);
      await pool.query(
        `DELETE FROM document_associations
          WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)`,
        [workspaceId],
      );
      await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[userId, memberId]]);
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    }
  });

  it('approve assign_issue: sets assignee, writes fleetgraph-attributed history, resolves the finding', async () => {
    const issueId = await seedIssue('Approve target');
    const findingId = await insertFinding({
      detector: 'orphan_intake',
      documentId: issueId,
      proposedAction: { type: 'assign_issue', issueId, assigneeId: memberId, reason: 'test' },
    });

    const res = await postDisposition(findingId, { action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.executed).toContain(`assigned to ${memberId}`);

    const doc = await pool.query(
      `SELECT properties->>'assignee_id' AS assignee_id FROM documents WHERE id = $1`,
      [issueId],
    );
    expect(doc.rows[0].assignee_id).toBe(memberId);

    const history = await pool.query(
      `SELECT field, old_value, new_value, changed_by, automated_by
         FROM document_history WHERE document_id = $1 AND field = 'assignee_id'`,
      [issueId],
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({
      new_value: memberId,
      changed_by: userId,
      automated_by: 'fleetgraph',
    });

    const finding = await getFinding(findingId);
    expect(finding.status).toBe('approved');
    expect(finding.resolved_at).not.toBeNull();
  });

  it('change with assignee_id overrides the proposal target', async () => {
    const issueId = await seedIssue('Change target');
    const findingId = await insertFinding({
      detector: 'orphan_intake',
      documentId: issueId,
      proposedAction: { type: 'assign_issue', issueId, assigneeId: memberId, reason: 'test' },
    });

    const res = await postDisposition(findingId, { action: 'change', assignee_id: userId });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('changed');

    const doc = await pool.query(
      `SELECT properties->>'assignee_id' AS assignee_id FROM documents WHERE id = $1`,
      [issueId],
    );
    // The human's pick (userId) wins over the proposal's memberId.
    expect(doc.rows[0].assignee_id).toBe(userId);
    expect((await getFinding(findingId)).status).toBe('changed');
  });

  it('move_issues_out_of_week: approves only the checked subset, records declined ids and history', async () => {
    const i1 = await seedIssue('Move checked 1');
    const i2 = await seedIssue('Move checked 2');
    const i3 = await seedIssue('Move unchecked');
    const weekId = await seedWeekWithIssues('Move week', [i1, i2, i3]);
    const findingId = await insertFinding({
      detector: 'week_slip',
      documentId: weekId,
      proposedAction: {
        type: 'move_issues_out_of_week',
        weekId,
        items: [
          { issueId: i1, title: 'a', state: 'todo', priority: 'low' },
          { issueId: i2, title: 'b', state: 'todo', priority: 'low' },
          { issueId: i3, title: 'c', state: 'todo', priority: 'low' },
        ],
        reason: 'test',
      },
    });

    const res = await postDisposition(findingId, { action: 'approve', issue_ids: [i1, i2] });
    expect(res.status).toBe(200);
    expect(res.body.executed).toContain('moved 2 issue(s)');

    const assoc = await pool.query(
      `SELECT document_id FROM document_associations
        WHERE related_id = $1 AND relationship_type = 'sprint'`,
      [weekId],
    );
    // ONLY the checked ids lost their sprint association.
    expect(assoc.rows.map((r) => r.document_id)).toEqual([i3]);

    const finding = await getFinding(findingId);
    expect(finding.evidence.movedIssueIds).toEqual([i1, i2]);
    expect(finding.evidence.declinedIssueIds).toEqual([i3]);

    const history = await pool.query(
      `SELECT document_id, old_value, new_value, automated_by
         FROM document_history
        WHERE field = 'sprint_id' AND document_id = ANY($1)
        ORDER BY id`,
      [[i1, i2, i3]],
    );
    expect(history.rows.map((r) => r.document_id)).toEqual([i1, i2]);
    for (const row of history.rows) {
      expect(row).toMatchObject({ old_value: weekId, new_value: null, automated_by: 'fleetgraph' });
    }
  });

  it('subset smuggling blocked: an issue_id not in the proposal is ignored, not executed', async () => {
    const inProposal = await seedIssue('Smuggle legit');
    const outsider = await seedIssue('Smuggle outsider');
    const weekId = await seedWeekWithIssues('Smuggle week', [inProposal, outsider]);
    const findingId = await insertFinding({
      detector: 'week_slip',
      documentId: weekId,
      proposedAction: {
        type: 'move_issues_out_of_week',
        weekId,
        items: [{ issueId: inProposal, title: 'a', state: 'todo', priority: 'low' }],
        reason: 'test',
      },
    });

    const res = await postDisposition(findingId, {
      action: 'approve',
      issue_ids: [inProposal, outsider],
    });
    expect(res.status).toBe(200);
    expect(res.body.executed).toContain('moved 1 issue(s)');

    // The smuggled id kept its association and got no history row.
    const assoc = await pool.query(
      `SELECT document_id FROM document_associations
        WHERE related_id = $1 AND relationship_type = 'sprint'`,
      [weekId],
    );
    expect(assoc.rows.map((r) => r.document_id)).toEqual([outsider]);
    const history = await pool.query(
      `SELECT id FROM document_history WHERE document_id = $1 AND field = 'sprint_id'`,
      [outsider],
    );
    expect(history.rows).toHaveLength(0);
    expect((await getFinding(findingId)).evidence.movedIssueIds).toEqual([inProposal]);
  });

  it('approve with zero valid checked ids is a 400 and the finding stays open', async () => {
    const issueId = await seedIssue('Zero checked');
    const weekId = await seedWeekWithIssues('Zero week', [issueId]);
    const findingId = await insertFinding({
      detector: 'week_slip',
      documentId: weekId,
      proposedAction: {
        type: 'move_issues_out_of_week',
        weekId,
        items: [{ issueId, title: 'a', state: 'todo', priority: 'low' }],
        reason: 'test',
      },
    });

    const res = await postDisposition(findingId, {
      action: 'approve',
      issue_ids: [crypto.randomUUID()], // valid uuid, but not in the proposal
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('at least one checked issue');

    // Nothing executed, nothing dispositioned.
    const assoc = await pool.query(
      `SELECT document_id FROM document_associations
        WHERE related_id = $1 AND relationship_type = 'sprint'`,
      [weekId],
    );
    expect(assoc.rows).toHaveLength(1);
    expect((await getFinding(findingId)).status).toBe('open');
  });

  it('dismiss and snooze: statuses recorded, snooze_until lands ~2 days out', async () => {
    const dismissId = await insertFinding({ detector: 'stale_issue' });
    const snoozeId = await insertFinding({ detector: 'stale_issue' });

    const dismissRes = await postDisposition(dismissId, { action: 'dismiss' });
    expect(dismissRes.status).toBe(200);
    const dismissed = await getFinding(dismissId);
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.resolved_at).not.toBeNull();

    const snoozeRes = await postDisposition(snoozeId, { action: 'snooze' });
    expect(snoozeRes.status).toBe(200);
    const snoozed = await getFinding(snoozeId);
    expect(snoozed.status).toBe('snoozed');
    expect(snoozed.resolved_at).toBeNull(); // snooze re-arms; it does not resolve
    const hoursOut = (new Date(snoozed.snooze_until).getTime() - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(47);
    expect(hoursOut).toBeLessThan(49);
  });

  it('still_on_it: sets self_reported, records the status, resolves the card', async () => {
    const findingId = await insertFinding({ detector: 'stuck_review' });

    const res = await postDisposition(findingId, { action: 'still_on_it' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('still_on_it');

    const finding = await getFinding(findingId);
    expect(finding.status).toBe('still_on_it');
    expect(finding.self_reported).toBe(true);
    expect(finding.resolved_at).not.toBeNull();
  });

  it('credibility: approve grows alpha, dismiss grows beta, both through the 0.9-discount update', async () => {
    // 'urgent_idle' is reserved for this test so the (user, finding_type)
    // row starts from the INSERT branch: approve → (1+1, 1+0) = (2, 1).
    const issueId = await seedIssue('Credibility target');
    const approveFinding = await insertFinding({
      detector: 'urgent_idle',
      documentId: issueId,
      proposedAction: { type: 'assign_issue', issueId, assigneeId: memberId, reason: 'test' },
    });
    expect((await postDisposition(approveFinding, { action: 'approve' })).status).toBe(200);

    const readCred = async () => {
      const { rows } = await pool.query(
        `SELECT alpha, beta FROM agent_credibility
          WHERE user_id = $1 AND finding_type = 'urgent_idle'`,
        [userId],
      );
      return rows[0];
    };
    const afterApprove = await readCred();
    expect(afterApprove.alpha).toBeCloseTo(2.0, 4);
    expect(afterApprove.beta).toBeCloseTo(1.0, 4);

    // Dismiss on the same type: alpha = 0.9*2 + 0 = 1.8, beta = 0.9*1 + 1 = 1.9.
    const dismissFinding = await insertFinding({ detector: 'urgent_idle' });
    expect((await postDisposition(dismissFinding, { action: 'dismiss' })).status).toBe(200);

    const afterDismiss = await readCred();
    expect(afterDismiss.alpha).toBeCloseTo(1.8, 4);
    expect(afterDismiss.beta).toBeCloseTo(1.9, 4);
  });

  it('GET /findings excludes resolved rows and snoozed-in-future rows', async () => {
    // Clear the residue of earlier tests so the visible set is exact.
    await pool.query(
      `UPDATE agent_findings SET status = 'resolved', resolved_at = NOW()
        WHERE workspace_id = $1 AND resolved_at IS NULL`,
      [workspaceId],
    );

    const visibleId = await insertFinding({ detector: 'orphan_intake' });
    const pastSnoozeId = await insertFinding({ detector: 'stale_issue', snoozeHours: -1 });
    await insertFinding({ detector: 'stale_issue', snoozeHours: 24 }); // future snooze → hidden
    await insertFinding({ detector: 'stuck_review', status: 'resolved', resolved: true }); // hidden

    const res = await request(app).get('/api/agent/findings').set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    const ids = res.body.findings.map((f: { id: string }) => f.id).sort();
    expect(ids).toEqual([visibleId, pastSnoozeId].sort());
  });
});
