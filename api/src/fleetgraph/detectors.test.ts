/**
 * FleetGraph detector regression tests — the deterministic SQL rules, called
 * directly with the real pool against ship_test. No LLM, no HTTP, no sleeps:
 * every "aged" condition is seeded with backdated timestamps (the e2e-modes
 * convention), and the week-slip elapsed fraction is controlled by backdating
 * workspaces.sprint_start_date at workspace creation.
 *
 * Also hosts the pure attention.ts (E1 gate) tests: gateRecipients with an
 * injectable deterministic rng. The chosen credibility numbers make each
 * assertion rng-independent (see comments inline), so nothing here can flake.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/client.js';
import {
  detectOrphanIntake,
  detectStaleIssues,
  detectStuckReview,
  detectUrgentIdle,
  detectDueSoonIdle,
  detectWeekSlip,
  autoResolveCleared,
  ORPHAN_GRACE_SECONDS,
  STALE_IDLE_DAYS,
  STUCK_REVIEW_DAYS,
  URGENT_IDLE_DAYS,
} from './detectors.js';
import { gateRecipients, PROBE_DAYS, type Rng, type CredibilityRow } from './attention.js';

describe('FleetGraph detectors (direct, real ship_test)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let workspaceId: string;
  let userId: string;
  let projectId: string;

  /** Seed an issue; backdate created_at/updated_at when asked (no sleeps). */
  async function seedIssue(opts: {
    title: string;
    state?: string;
    priority?: string;
    assigneeId?: string;
    backdateSeconds?: number;
  }): Promise<string> {
    const properties: Record<string, string> = { state: opts.state ?? 'todo' };
    if (opts.priority) properties.priority = opts.priority;
    if (opts.assigneeId) properties.assignee_id = opts.assigneeId;
    const { rows } = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by, properties)
       VALUES ($1, 'issue', $2, 'workspace', $3, $4)
       RETURNING id`,
      [workspaceId, `${opts.title} ${testRunId}`, userId, JSON.stringify(properties)],
    );
    const issueId: string = rows[0].id;
    if (opts.backdateSeconds) {
      await pool.query(
        `UPDATE documents
            SET created_at = NOW() - make_interval(secs => $2),
                updated_at = NOW() - make_interval(secs => $2)
          WHERE id = $1`,
        [issueId, opts.backdateSeconds],
      );
    }
    return issueId;
  }

  const DAY = 86_400;

  beforeAll(async () => {
    process.env.FLEETGRAPH_ENABLED = 'false';

    // sprint_start_date 4 days ago => week 1 is active and ~57% elapsed,
    // comfortably past SLIP_MIN_ELAPSED (0.5) whatever the time of day.
    const ws = await pool.query(
      `INSERT INTO workspaces (name, sprint_start_date)
       VALUES ($1, CURRENT_DATE - 4) RETURNING id`,
      [`FleetGraph detectors ${testRunId}`],
    );
    workspaceId = ws.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Detector Test User') RETURNING id`,
      [`fleetgraph-detectors-${testRunId}@ship.local`],
    );
    userId = user.rows[0].id;
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    const project = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, properties)
       VALUES ($1, 'project', 'Detector Project', 'workspace', $2) RETURNING id`,
      [workspaceId, JSON.stringify({ owner_id: userId })],
    );
    projectId = project.rows[0].id;
  });

  afterAll(async () => {
    if (workspaceId) {
      // agent_* tables are not truncated by setup.ts — clean our rows here.
      await pool.query(`DELETE FROM agent_findings WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM agent_credibility WHERE user_id = $1`, [userId]);
      await pool.query(
        `DELETE FROM document_associations
          WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)`,
        [workspaceId],
      );
      await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM workspace_memberships WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    }
  });

  it('orphan_intake: fires only past the 90s grace, and carries an assign_issue proposal when a member exists', async () => {
    const freshId = await seedIssue({ title: 'Fresh orphan', state: 'todo' });
    const ripeId = await seedIssue({
      title: 'Ripe orphan',
      state: 'todo',
      backdateSeconds: ORPHAN_GRACE_SECONDS * 2,
    });
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'project')`,
      [ripeId, projectId],
    );

    const findings = await detectOrphanIntake(pool, workspaceId);

    // Boundary: inside the grace window, silence.
    expect(findings.find((f) => f.documentId === freshId)).toBeUndefined();

    const ripe = findings.find((f) => f.documentId === ripeId);
    expect(ripe).toBeDefined();
    expect(ripe!.detector).toBe('orphan_intake');
    expect(ripe!.dedupKey).toBe(`orphan_intake:${ripeId}`);
    expect(ripe!.notifyUserIds).toEqual([userId]); // project owner via RACI
    // Proposal: deterministic assignee pick (the only member = lightest load).
    const action = ripe!.proposedAction;
    if (!action || action.type !== 'assign_issue') {
      throw new Error('expected an assign_issue proposal');
    }
    expect(action.issueId).toBe(ripeId);
    expect(action.assigneeId).toBe(userId);
  });

  it('stale_issue: in_progress idle 3+ days fires; fresh in_progress does not', async () => {
    const staleId = await seedIssue({
      title: 'Stale WIP',
      state: 'in_progress',
      backdateSeconds: (STALE_IDLE_DAYS + 1) * DAY,
    });
    const freshId = await seedIssue({ title: 'Fresh WIP', state: 'in_progress' });

    const findings = await detectStaleIssues(pool, workspaceId);
    const stale = findings.find((f) => f.documentId === staleId);
    expect(stale).toBeDefined();
    expect(stale!.severity).toBe('medium');
    expect(findings.find((f) => f.documentId === freshId)).toBeUndefined();
  });

  it('stuck_review: in_review idle 2+ days fires; recently-touched in_review does not', async () => {
    const stuckId = await seedIssue({
      title: 'Stuck review',
      state: 'in_review',
      backdateSeconds: (STUCK_REVIEW_DAYS + 1) * DAY,
    });
    const activeId = await seedIssue({ title: 'Active review', state: 'in_review' });

    const findings = await detectStuckReview(pool, workspaceId);
    const stuck = findings.find((f) => f.documentId === stuckId);
    expect(stuck).toBeDefined();
    expect(stuck!.evidence.state).toBe('in_review');
    expect(findings.find((f) => f.documentId === activeId)).toBeUndefined();
  });

  it('urgent_idle: urgent+todo idle fires; urgent+in_progress and cancelled are excluded', async () => {
    const idleDays = (URGENT_IDLE_DAYS + 1) * DAY;
    const urgentTodoId = await seedIssue({
      title: 'Urgent untouched',
      state: 'todo',
      priority: 'urgent',
      backdateSeconds: idleDays,
    });
    const urgentWipId = await seedIssue({
      title: 'Urgent but moving',
      state: 'in_progress',
      priority: 'urgent',
      backdateSeconds: idleDays,
    });
    const cancelledId = await seedIssue({
      title: 'Urgent cancelled',
      state: 'cancelled',
      priority: 'urgent',
      backdateSeconds: idleDays,
    });

    const findings = await detectUrgentIdle(pool, workspaceId);
    const hit = findings.find((f) => f.documentId === urgentTodoId);
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
    expect(findings.find((f) => f.documentId === urgentWipId)).toBeUndefined();
    expect(findings.find((f) => f.documentId === cancelledId)).toBeUndefined();
  });

  it('due_soon_idle: due tomorrow + idle fires; due next week and done are excluded', async () => {
    const dueTomorrowId = await seedIssue({ title: 'Due tomorrow idle', state: 'todo' });
    const dueFarId = await seedIssue({ title: 'Due next week idle', state: 'todo' });
    const dueDoneId = await seedIssue({ title: 'Due tomorrow but done', state: 'done' });
    // Set due dates server-side (no client-clock/midnight skew) + backdate
    // updated_at past DUE_SOON_IDLE_DAYS in the same statement.
    await pool.query(
      `UPDATE documents
          SET properties = properties || jsonb_build_object('due_date', (CURRENT_DATE + 1)::text),
              updated_at = NOW() - interval '2 days'
        WHERE id = ANY($1)`,
      [[dueTomorrowId, dueDoneId]],
    );
    await pool.query(
      `UPDATE documents
          SET properties = properties || jsonb_build_object('due_date', (CURRENT_DATE + 7)::text),
              updated_at = NOW() - interval '2 days'
        WHERE id = $1`,
      [dueFarId],
    );

    const findings = await detectDueSoonIdle(pool, workspaceId);
    const hit = findings.find((f) => f.documentId === dueTomorrowId);
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
    expect(hit!.dedupKey).toBe(`due_soon_idle:${dueTomorrowId}:${hit!.evidence.dueDate}`);
    expect(findings.find((f) => f.documentId === dueFarId)).toBeUndefined();
    expect(findings.find((f) => f.documentId === dueDoneId)).toBeUndefined();
  });

  describe('week_slip', () => {
    let weekId: string;
    let emptyWeekId: string;
    let lowId: string;
    let medId: string;
    let highId: string;

    beforeAll(async () => {
      const mkWeek = async (title: string) => {
        const { rows } = await pool.query(
          `INSERT INTO documents (workspace_id, document_type, title, visibility, properties)
           VALUES ($1, 'sprint', $2, 'workspace', $3) RETURNING id`,
          [workspaceId, `${title} ${testRunId}`, JSON.stringify({ sprint_number: 1, owner_id: userId })],
        );
        return rows[0].id as string;
      };
      weekId = await mkWeek('Week 1');
      emptyWeekId = await mkWeek('Week 1 (empty)');

      lowId = await seedIssue({ title: 'Slip low', state: 'todo', priority: 'low' });
      medId = await seedIssue({ title: 'Slip medium', state: 'todo', priority: 'medium' });
      highId = await seedIssue({ title: 'Slip high', state: 'todo', priority: 'high' });
      for (const issueId of [lowId, medId, highId]) {
        await pool.query(
          `INSERT INTO document_associations (document_id, related_id, relationship_type)
           VALUES ($1, $2, 'sprint')`,
          [issueId, weekId],
        );
      }
    });

    it('fires at ~57% elapsed with 0/3 done, proposal items lowest-priority first; zero-issue week stays quiet', async () => {
      const findings = await detectWeekSlip(pool, workspaceId);

      expect(findings.find((f) => f.documentId === emptyWeekId)).toBeUndefined();

      const slip = findings.find((f) => f.documentId === weekId);
      expect(slip).toBeDefined();
      expect(slip!.severity).toBe('high');
      expect(slip!.evidence).toMatchObject({ issueCount: 3, completedCount: 0, donePct: 0 });
      expect(Number(slip!.evidence.elapsedPct)).toBeGreaterThanOrEqual(50);
      const action = slip!.proposedAction;
      if (!action || action.type !== 'move_issues_out_of_week') {
        throw new Error('expected a move_issues_out_of_week proposal');
      }
      expect(action.weekId).toBe(weekId);
      // Sacrifice order: lowest priority first.
      expect(action.items.map((i) => i.issueId)).toEqual([lowId, medId, highId]);
    });

    it('does not fire when the done-rate is inside the gap (2/3 done at ~57% elapsed)', async () => {
      await pool.query(
        `UPDATE documents SET properties = jsonb_set(properties, '{state}', '"done"')
          WHERE id = ANY($1)`,
        [[lowId, medId]],
      );
      const findings = await detectWeekSlip(pool, workspaceId);
      // doneRate 0.67 >= elapsed (~0.57..0.71) - SLIP_GAP (0.3) → gap rule holds.
      expect(findings.find((f) => f.documentId === weekId)).toBeUndefined();
    });
  });

  it('autoResolveCleared: orphan resolves once assigned, stuck_review resolves once done', async () => {
    const orphanId = await seedIssue({
      title: 'AR orphan',
      state: 'todo',
      backdateSeconds: ORPHAN_GRACE_SECONDS * 2,
    });
    const stuckId = await seedIssue({
      title: 'AR stuck',
      state: 'in_review',
      backdateSeconds: (STUCK_REVIEW_DAYS + 1) * DAY,
    });
    const seedFinding = (detector: string, documentId: string, dedupKey: string) =>
      pool.query(
        `INSERT INTO agent_findings (workspace_id, document_id, detector, dedup_key, title, status)
         VALUES ($1, $2, $3, $4, 'seeded finding', 'open') RETURNING id`,
        [workspaceId, documentId, detector, dedupKey],
      );
    await seedFinding('orphan_intake', orphanId, `orphan_intake:${orphanId}`);
    await seedFinding('stuck_review', stuckId, `stuck_review:${stuckId}:seed`);

    // Conditions still hold → nothing resolves.
    expect(await autoResolveCleared(pool, workspaceId)).toBe(0);

    // Clear both conditions: assignee lands; review moves to done.
    await pool.query(
      `UPDATE documents SET properties = jsonb_set(properties, '{assignee_id}', to_jsonb($2::text))
        WHERE id = $1`,
      [orphanId, userId],
    );
    await pool.query(
      `UPDATE documents SET properties = jsonb_set(properties, '{state}', '"done"')
        WHERE id = $1`,
      [stuckId],
    );

    expect(await autoResolveCleared(pool, workspaceId)).toBe(2);

    const { rows } = await pool.query(
      `SELECT document_id, status, resolved_at FROM agent_findings
        WHERE workspace_id = $1 AND document_id = ANY($2)`,
      [workspaceId, [orphanId, stuckId]],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('resolved');
      expect(row.resolved_at).not.toBeNull();
    }
  });

  it('dedup keys date-bucket on the updated_at day (stale/stuck/urgent) and on today (week_slip)', async () => {
    const staleId = await seedIssue({
      title: 'Dedup stale',
      state: 'in_progress',
      backdateSeconds: 5 * DAY,
    });
    const stuckId = await seedIssue({
      title: 'Dedup stuck',
      state: 'in_review',
      backdateSeconds: 3 * DAY,
    });
    const urgentId = await seedIssue({
      title: 'Dedup urgent',
      state: 'todo',
      priority: 'urgent',
      backdateSeconds: 3 * DAY,
    });

    const dayOf = async (id: string) => {
      const { rows } = await pool.query(`SELECT updated_at FROM documents WHERE id = $1`, [id]);
      return new Date(rows[0].updated_at).toISOString().slice(0, 10);
    };

    const stale = (await detectStaleIssues(pool, workspaceId)).find((f) => f.documentId === staleId);
    expect(stale!.dedupKey).toBe(`stale_issue:${staleId}:${await dayOf(staleId)}`);

    const stuck = (await detectStuckReview(pool, workspaceId)).find((f) => f.documentId === stuckId);
    expect(stuck!.dedupKey).toBe(`stuck_review:${stuckId}:${await dayOf(stuckId)}`);

    const urgent = (await detectUrgentIdle(pool, workspaceId)).find((f) => f.documentId === urgentId);
    expect(urgent!.dedupKey).toBe(`urgent_idle:${urgentId}:${await dayOf(urgentId)}`);
    expect(urgent!.dedupKey).toMatch(/^urgent_idle:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/);

    // week_slip buckets on today's date (weeks re-arm daily while slipping).
    // Seed a dedicated behind week so this test does not depend on the
    // week_slip block having run.
    const { rows: wk } = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, properties)
       VALUES ($1, 'sprint', $2, 'workspace', $3) RETURNING id`,
      [workspaceId, `Dedup week ${testRunId}`, JSON.stringify({ sprint_number: 1 })],
    );
    const dedupWeekId: string = wk[0].id;
    const slipIssue = await seedIssue({ title: 'Dedup slip issue', state: 'todo' });
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'sprint')`,
      [slipIssue, dedupWeekId],
    );
    const today = new Date().toISOString().slice(0, 10);
    const slip = (await detectWeekSlip(pool, workspaceId)).find(
      (f) => f.documentId === dedupWeekId,
    );
    expect(slip).toBeDefined();
    expect(slip!.dedupKey).toBe(`week_slip:${dedupWeekId}:${today}`);
  });
});

describe('attention.ts E1 gate (pure, deterministic rng)', () => {
  /** Counter over a fixed array — deterministic and cycle-safe for the
   *  variable number of uniforms the gamma sampler consumes. */
  function makeRng(values: number[]): Rng {
    let i = 0;
    return () => values[i++ % values.length] ?? 0.5;
  }
  const rngValues = [0.42, 0.87, 0.13, 0.55, 0.66, 0.31, 0.77, 0.21];

  const now = new Date('2026-08-06T12:00:00Z');
  const cred = (alpha: number, beta: number, lastNotifiedAt: Date | null): CredibilityRow => ({
    user_id: 'u1',
    finding_type: 'stale_issue',
    alpha,
    beta,
    last_notified_at: lastNotifiedAt,
  });
  const finding = (severity: 'medium' | 'critical') => ({
    detector: 'stale_issue' as const,
    severity: severity as 'medium' | 'critical',
    notifyUserIds: ['u1'],
  });

  it('suppresses a medium finding for a low-credibility user (threshold above rank for any sample)', () => {
    // alpha=0.1, beta=20 → p̃ tiny; threshold = 1 + 2(1−p̃) ≈ 3 > medium rank 1.
    // In fact medium (rank 1 = θ0) clears the gate only if p̃ ≥ 1, which
    // sampleBeta never returns — suppression holds for ANY rng draw.
    const res = gateRecipients({
      finding: finding('medium'),
      credibility: new Map([['u1', cred(0.1, 20, now)]]),
      rng: makeRng(rngValues),
      now,
    });
    expect(res.notify).toEqual([]);
    expect(res.suppressed).toEqual(['u1']);
  });

  it('critical always interrupts, even with the worst credibility', () => {
    const res = gateRecipients({
      finding: finding('critical'),
      credibility: new Map([['u1', cred(0.1, 20, now)]]),
      rng: makeRng(rngValues),
      now,
    });
    expect(res.notify).toEqual(['u1']);
    expect(res.suppressed).toEqual([]);
  });

  it('forced probe: silent longer than PROBE_DAYS notifies despite bad credibility', () => {
    const last = new Date(now.getTime() - (PROBE_DAYS + 1) * 86_400_000);
    const res = gateRecipients({
      finding: finding('medium'),
      credibility: new Map([['u1', cred(0.1, 20, last)]]),
      rng: makeRng(rngValues),
      now,
    });
    expect(res.notify).toEqual(['u1']);
    expect(res.suppressed).toEqual([]);
  });

  it('cold start: a user with no credibility row is notified', () => {
    const res = gateRecipients({
      finding: finding('medium'),
      credibility: new Map(),
      rng: makeRng(rngValues),
      now,
    });
    expect(res.notify).toEqual(['u1']);
    expect(res.suppressed).toEqual([]);
  });
});
