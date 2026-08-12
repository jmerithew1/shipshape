/**
 * `ShipData` port regression tests (Week 6, Epic 7).
 *
 * Two claims, and they are different claims:
 *
 *  A. **The port did not change what the detectors decide.** Week 5's rules
 *     used to inline their own SQL; they now call the port. `PoolShipData`
 *     against the real ship_test database must produce exactly the findings
 *     the inline SQL produced — same rows, same dedup keys, same evidence,
 *     same recipients. `detectors.test.ts` (untouched, still passing a raw
 *     `pg.Pool`) is the primary proof; this file adds the adapter seam itself
 *     (`asShipData`) and the port-shaped row contract.
 *
 *  B. **The detectors genuinely read through the port.** Driven by
 *     `FakeShipData`, with no database at all: if a detector ever went back to
 *     issuing its own SQL, the fake would return rows that never reached the
 *     finding, and these assertions would fail. That is the flag-ON safety
 *     net that costs no server and no OAuth grant.
 *
 * Together they are what lets `FLEETGRAPH_VIA_SDK` flip in CI without the
 * Week-5 suite noticing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/client.js';
import {
  detectDueSoonIdle,
  detectOrphanIntake,
  detectStaleIssues,
  detectStuckReview,
  detectUrgentIdle,
  detectWeekSlip,
  ORPHAN_GRACE_SECONDS,
  STALE_IDLE_DAYS,
  STUCK_REVIEW_DAYS,
  URGENT_IDLE_DAYS,
  DUE_SOON_HOURS,
  DUE_SOON_IDLE_DAYS,
} from './detectors.js';
import { asShipData } from './ship-data.js';
import { PoolShipData } from './ship-data-pool.js';
import { SdkShipData } from './ship-data-sdk.js';
import { resolveShipData, viaSdkEnabled } from './index.js';
import { FakeShipData } from './test-fakes.js';

const DAY = 86_400;

describe('FLEETGRAPH_VIA_SDK — the flag that selects the implementation', () => {
  const saved = {
    flag: process.env.FLEETGRAPH_VIA_SDK,
    id: process.env.SHIP_AGENT_CLIENT_ID,
    secret: process.env.SHIP_AGENT_CLIENT_SECRET,
  };

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  afterAll(() => {
    restore('FLEETGRAPH_VIA_SDK', saved.flag);
    restore('SHIP_AGENT_CLIENT_ID', saved.id);
    restore('SHIP_AGENT_CLIENT_SECRET', saved.secret);
  });

  it('defaults OFF — an unset flag is the Week-5 pool path', () => {
    delete process.env.FLEETGRAPH_VIA_SDK;
    expect(viaSdkEnabled()).toBe(false);
    const resolved = resolveShipData(pool);
    expect(resolved.source).toBe('pool');
    expect(resolved.data).toBeInstanceOf(PoolShipData);
  });

  it('only "true" turns it on — no truthy-string surprises on a kill switch', () => {
    for (const value of ['false', '1', 'yes', 'TRUE', '']) {
      process.env.FLEETGRAPH_VIA_SDK = value;
      expect(viaSdkEnabled()).toBe(false);
    }
    process.env.FLEETGRAPH_VIA_SDK = 'true';
    expect(viaSdkEnabled()).toBe(true);
  });

  it('ON with credentials selects the SDK implementation', () => {
    process.env.FLEETGRAPH_VIA_SDK = 'true';
    process.env.SHIP_AGENT_CLIENT_ID = 'ship_app_deadbeefdeadbeef';
    process.env.SHIP_AGENT_CLIENT_SECRET = 'ship_sec_not_a_real_secret';

    const resolved = resolveShipData(pool);
    expect(resolved.source).toBe('sdk');
    expect(resolved.data).toBeInstanceOf(SdkShipData);
  });

  it('ON without credentials degrades to the pool rather than reading nothing', () => {
    // The failure mode this prevents: an agent with no identity would return
    // empty result sets, which look exactly like "no problems found". A
    // monitoring agent must never fail silent-and-clean.
    process.env.FLEETGRAPH_VIA_SDK = 'true';
    delete process.env.SHIP_AGENT_CLIENT_ID;
    delete process.env.SHIP_AGENT_CLIENT_SECRET;

    const resolved = resolveShipData(pool);
    expect(resolved.source).toBe('pool');
    expect(resolved.data).toBeInstanceOf(PoolShipData);
  });
});

describe('asShipData — the adapter that keeps the Week-5 call signature alive', () => {
  it('wraps a raw pg.Pool in PoolShipData', () => {
    expect(asShipData(pool)).toBeInstanceOf(PoolShipData);
  });

  it('passes an existing ShipData through untouched (no double-wrapping)', () => {
    const fake = new FakeShipData();
    expect(asShipData(fake)).toBe(fake);
  });
});

describe('detectors read through the port (FakeShipData, zero database)', () => {
  const workspaceId = '11111111-1111-1111-1111-111111111111';
  const projectId = '22222222-2222-2222-2222-222222222222';
  const ownerId = '33333333-3333-3333-3333-333333333333';
  const assigneeId = '44444444-4444-4444-4444-444444444444';
  const issueId = '55555555-5555-5555-5555-555555555555';
  const weekId = '66666666-6666-6666-6666-666666666666';

  const issueRow = (updatedAt: Date) => ({
    id: issueId,
    title: 'Ported issue',
    workspaceId,
    updatedAt,
    assigneeId,
    projectId,
    projectOwnerId: ownerId,
  });

  it('orphan_intake builds its card and its assign proposal from port rows only', async () => {
    const data = new FakeShipData({
      orphans: [
        { id: issueId, title: 'Ported orphan', workspaceId, projectId, projectOwnerId: ownerId },
      ],
      lightestMember: { userId: assigneeId, activeLoad: 2 },
    });

    const [finding] = await detectOrphanIntake(data, workspaceId);

    expect(data.calls).toEqual(['findOrphanCandidates', 'findLightestLoadedMember']);
    expect(finding!.dedupKey).toBe(`orphan_intake:${issueId}`);
    expect(finding!.documentTitle).toBe('Ported orphan');
    expect(finding!.projectId).toBe(projectId);
    expect(finding!.notifyUserIds).toEqual([ownerId]);
    expect(finding!.evidence).toMatchObject({
      graceSeconds: ORPHAN_GRACE_SECONDS,
      proposedAssigneeLoad: 2,
    });
    const action = finding!.proposedAction;
    if (!action || action.type !== 'assign_issue') throw new Error('expected assign_issue');
    expect(action.assigneeId).toBe(assigneeId);
  });

  it('orphan_intake short-circuits: no candidates means the load read never happens', async () => {
    const data = new FakeShipData({ orphans: [] });
    expect(await detectOrphanIntake(data, workspaceId)).toEqual([]);
    // The $0 path is structural: no rows, no follow-up read, no LLM.
    expect(data.calls).toEqual(['findOrphanCandidates']);
  });

  it('stale_issue date-buckets its dedup key on the port row updatedAt', async () => {
    const updatedAt = new Date('2026-08-01T09:30:00Z');
    const data = new FakeShipData({ stale: [issueRow(updatedAt)] });

    const [finding] = await detectStaleIssues(data, workspaceId);

    expect(data.calls).toEqual(['findStaleIssues']);
    expect(finding!.dedupKey).toBe(`stale_issue:${issueId}:2026-08-01`);
    expect(finding!.severity).toBe('medium');
    expect(finding!.evidence).toMatchObject({ idleDays: STALE_IDLE_DAYS, lastActivityAt: updatedAt });
    // Recipient resolution: assignee first, then project owner (RACI).
    expect(finding!.notifyUserIds).toEqual([assigneeId, ownerId]);
  });

  it('stuck_review and urgent_idle carry their own severities and evidence', async () => {
    const updatedAt = new Date('2026-07-30T12:00:00Z');
    const stuckData = new FakeShipData({ stuckReviews: [issueRow(updatedAt)] });
    const [stuck] = await detectStuckReview(stuckData, workspaceId);
    expect(stuck!.dedupKey).toBe(`stuck_review:${issueId}:2026-07-30`);
    expect(stuck!.evidence).toMatchObject({ idleDays: STUCK_REVIEW_DAYS, state: 'in_review' });

    const urgentData = new FakeShipData({
      urgentIdle: [{ ...issueRow(updatedAt), state: 'todo' }],
    });
    const [urgent] = await detectUrgentIdle(urgentData, workspaceId);
    expect(urgent!.severity).toBe('high');
    expect(urgent!.evidence).toMatchObject({
      idleDays: URGENT_IDLE_DAYS,
      state: 'todo',
      priority: 'urgent',
    });
  });

  it('due_soon_idle keys on the due date the port returned, not on a clock', async () => {
    const data = new FakeShipData({
      dueSoon: [{ ...issueRow(new Date('2026-08-05T00:00:00Z')), dueDate: '2026-08-07' }],
    });
    const [finding] = await detectDueSoonIdle(data, workspaceId);

    expect(data.calls).toEqual(['findDueSoonIdleIssues']);
    expect(finding!.dedupKey).toBe(`due_soon_idle:${issueId}:2026-08-07`);
    expect(finding!.evidence).toMatchObject({
      dueDate: '2026-08-07',
      idleDays: DUE_SOON_IDLE_DAYS,
    });
    expect(DUE_SOON_HOURS).toBe(48);
  });

  it('week_slip computes elapsed/done arithmetic from port rows and proposes the cut list', async () => {
    // Anchor week 1 five days ago: ~71% elapsed, 0/2 done → fires.
    const sprintStartDate = new Date(Date.now() - 5 * DAY * 1000);
    const data = new FakeShipData({
      activeWeeks: [
        {
          id: weekId,
          title: 'Week 1',
          workspaceId,
          sprintNumber: 1,
          sprintStartDate,
          projectId,
          projectOwnerId: ownerId,
          weekOwnerId: assigneeId,
          issueCount: 2,
          completedCount: 0,
        },
      ],
      weekIssues: {
        [weekId]: [
          { id: 'a', title: 'Cheap to cut', state: 'todo', priority: 'low' },
          { id: 'b', title: 'Costly to cut', state: 'todo', priority: 'high' },
        ],
      },
    });

    const [slip] = await detectWeekSlip(data, workspaceId);

    expect(data.calls).toEqual(['findActiveWeeks', 'findNotStartedWeekIssues']);
    expect(slip!.severity).toBe('high');
    expect(slip!.evidence).toMatchObject({ issueCount: 2, completedCount: 0, donePct: 0 });
    expect(Number(slip!.evidence.elapsedPct)).toBeGreaterThanOrEqual(50);
    expect(slip!.notifyUserIds).toEqual([assigneeId, ownerId]);
    const action = slip!.proposedAction;
    if (!action || action.type !== 'move_issues_out_of_week') {
      throw new Error('expected move_issues_out_of_week');
    }
    expect(action.items.map((i) => i.issueId)).toEqual(['a', 'b']);
  });

  it('week_slip stays quiet for an empty week without reading its issues', async () => {
    const data = new FakeShipData({
      activeWeeks: [
        {
          id: weekId,
          title: 'Empty week',
          workspaceId,
          sprintNumber: 1,
          sprintStartDate: new Date(Date.now() - 5 * DAY * 1000),
          projectId: null,
          projectOwnerId: null,
          weekOwnerId: null,
          issueCount: 0,
          completedCount: 0,
        },
      ],
    });
    expect(await detectWeekSlip(data, workspaceId)).toEqual([]);
    expect(data.calls).toEqual(['findActiveWeeks']);
  });
});

describe('PoolShipData — the flag-OFF path, against real ship_test rows', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let workspaceId: string;
  let userId: string;
  let projectId: string;
  let data: PoolShipData;

  async function seedIssue(opts: {
    title: string;
    state?: string;
    priority?: string;
    backdateSeconds?: number;
    systemGenerated?: boolean;
  }): Promise<string> {
    const properties: Record<string, string> = { state: opts.state ?? 'todo' };
    if (opts.priority) properties.priority = opts.priority;
    if (opts.systemGenerated) properties.is_system_generated = 'true';
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

  beforeAll(async () => {
    process.env.FLEETGRAPH_ENABLED = 'false';
    data = new PoolShipData(pool);

    const ws = await pool.query(
      `INSERT INTO workspaces (name, sprint_start_date)
       VALUES ($1, CURRENT_DATE - 4) RETURNING id`,
      [`ShipData port ${testRunId}`],
    );
    workspaceId = ws.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Port Test User') RETURNING id`,
      [`shipdata-port-${testRunId}@ship.local`],
    );
    userId = user.rows[0].id;
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    const project = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, properties)
       VALUES ($1, 'project', 'Port Project', 'workspace', $2) RETURNING id`,
      [workspaceId, JSON.stringify({ owner_id: userId })],
    );
    projectId = project.rows[0].id;
  });

  afterAll(async () => {
    if (workspaceId) {
      await pool.query(`DELETE FROM agent_findings WHERE workspace_id = $1`, [workspaceId]);
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

  it('returns port-shaped rows with project attribution resolved through associations', async () => {
    const issueId = await seedIssue({
      title: 'Port stale',
      state: 'in_progress',
      backdateSeconds: (STALE_IDLE_DAYS + 1) * DAY,
    });
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'project')`,
      [issueId, projectId],
    );

    const rows = await data.findStaleIssues(workspaceId, STALE_IDLE_DAYS);
    const row = rows.find((r) => r.id === issueId);

    expect(row).toBeDefined();
    expect(row!.workspaceId).toBe(workspaceId);
    expect(row!.projectId).toBe(projectId);
    expect(row!.projectOwnerId).toBe(userId);
    // Dates cross the port as Dates, so dedup-key bucketing is clock-safe.
    expect(row!.updatedAt).toBeInstanceOf(Date);
  });

  it('keeps the DB-clock grace window: a fresh orphan is invisible, a ripe one is not', async () => {
    const fresh = await seedIssue({ title: 'Port fresh orphan' });
    const ripe = await seedIssue({
      title: 'Port ripe orphan',
      backdateSeconds: ORPHAN_GRACE_SECONDS * 2,
    });

    const rows = await data.findOrphanCandidates(workspaceId, ORPHAN_GRACE_SECONDS);
    expect(rows.map((r) => r.id)).toContain(ripe);
    expect(rows.map((r) => r.id)).not.toContain(fresh);
  });

  it('excludes system-generated issues, and findIssueAttribution reports the flag', async () => {
    const human = await seedIssue({
      title: 'Port human review',
      state: 'in_review',
      backdateSeconds: (STUCK_REVIEW_DAYS + 1) * DAY,
    });
    const robot = await seedIssue({
      title: 'Port system review',
      state: 'in_review',
      backdateSeconds: (STUCK_REVIEW_DAYS + 1) * DAY,
      systemGenerated: true,
    });

    const rows = await data.findStuckReviews(workspaceId, STUCK_REVIEW_DAYS);
    expect(rows.map((r) => r.id)).toContain(human);
    expect(rows.map((r) => r.id)).not.toContain(robot);

    // The same exclusion, exposed as data — this is what the SDK path uses to
    // reapply the filter that /api/v1 cannot express (GAP-3).
    const attribution = await data.findIssueAttribution([human, robot]);
    expect(attribution.get(human)?.isSystemGenerated).toBe(false);
    expect(attribution.get(robot)?.isSystemGenerated).toBe(true);
    expect(attribution.get(human)?.projectOwnerId).toBeNull();
  });

  it('findIssueAttribution is a no-op on an empty id list (no query, no crash)', async () => {
    expect(await data.findIssueAttribution([])).toEqual(new Map());
  });

  it('findLightestLoadedMember returns the sole member with a numeric load', async () => {
    const member = await data.findLightestLoadedMember(workspaceId);
    expect(member).not.toBeNull();
    expect(member!.userId).toBe(userId);
    expect(typeof member!.activeLoad).toBe('number');
  });

  it('urgent-idle and due-soon reads survive the port with their SQL semantics intact', async () => {
    const urgent = await seedIssue({
      title: 'Port urgent',
      state: 'todo',
      priority: 'urgent',
      backdateSeconds: (URGENT_IDLE_DAYS + 1) * DAY,
    });
    const moving = await seedIssue({
      title: 'Port urgent moving',
      state: 'in_progress',
      priority: 'urgent',
      backdateSeconds: (URGENT_IDLE_DAYS + 1) * DAY,
    });
    const urgentRows = await data.findUrgentIdleIssues(workspaceId, URGENT_IDLE_DAYS);
    expect(urgentRows.map((r) => r.id)).toContain(urgent);
    expect(urgentRows.map((r) => r.id)).not.toContain(moving);
    expect(urgentRows.find((r) => r.id === urgent)!.state).toBe('todo');

    const dueSoon = await seedIssue({ title: 'Port due soon', state: 'todo' });
    await pool.query(
      `UPDATE documents
          SET properties = properties || jsonb_build_object('due_date', (CURRENT_DATE + 1)::text),
              updated_at = NOW() - interval '2 days'
        WHERE id = $1`,
      [dueSoon],
    );
    const dueRows = await data.findDueSoonIdleIssues(
      workspaceId,
      DUE_SOON_HOURS,
      DUE_SOON_IDLE_DAYS,
    );
    const dueRow = dueRows.find((r) => r.id === dueSoon);
    expect(dueRow).toBeDefined();
    // The due date crosses the port as the raw property string the dedup key
    // is built from — never a Date, which would reintroduce timezone drift.
    expect(typeof dueRow!.dueDate).toBe('string');
  });

  it('findActiveWeeks returns numeric rollups (pg bigint strings coerced at the port)', async () => {
    const { rows: wk } = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, properties)
       VALUES ($1, 'sprint', $2, 'workspace', $3) RETURNING id`,
      [workspaceId, `Port week ${testRunId}`, JSON.stringify({ sprint_number: 1, owner_id: userId })],
    );
    const weekId: string = wk[0].id;
    const issueId = await seedIssue({ title: 'Port week issue', state: 'todo', priority: 'low' });
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'sprint')`,
      [issueId, weekId],
    );

    const weeks = await data.findActiveWeeks(workspaceId);
    const week = weeks.find((w) => w.id === weekId);
    expect(week).toBeDefined();
    expect(week!.sprintNumber).toBe(1);
    expect(week!.issueCount).toBe(1);
    expect(week!.completedCount).toBe(0);
    expect(week!.weekOwnerId).toBe(userId);
    expect(week!.sprintStartDate).toBeInstanceOf(Date);

    const notStarted = await data.findNotStartedWeekIssues(weekId, 10);
    expect(notStarted.map((i) => i.id)).toEqual([issueId]);
    expect(notStarted[0]!.priority).toBe('low');
  });
});
