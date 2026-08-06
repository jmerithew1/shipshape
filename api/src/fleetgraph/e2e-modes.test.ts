/**
 * FleetGraph E2E — both agent modes, in CI, on stable fakes. No live LLM,
 * no network: models are injected via initFleetGraph(pool, modelsOverride)
 * (the CI-fakes seam), everything else is the real stack — Express app via
 * supertest, real Postgres (ship_test), the real LangGraph graph.
 *
 * Covers the graded requirement:
 *  1. Proactive: an orphan-intake state is introduced (backdated past the
 *     90s grace) and the agent surfaces it within the detection window.
 *  2. On-demand: the context-aware chat door returns a response grounded in
 *     the document the user is viewing (loaded from the DB by the graph).
 *  Plus: dedup (second sweep is quiet) and graceful degradation (failing
 *  models -> breaker opens -> rule-based findings still land, chat answers
 *  honestly with degraded: true).
 *
 * Timing note: the detection window in production is the sweep cadence
 * (FLEETGRAPH_SWEEP_MINUTES, default 2, max acceptable 5 minutes). Tests
 * invoke the same sweep entrypoint directly and assert the in-process
 * detection latency is < 5s — trivially inside the 5-minute window, with
 * zero sleeps (the "aged" state is seeded with backdated timestamps).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';
import { initFleetGraph, type FleetRuntime } from './index.js';
import {
  makeFakeModels,
  FAKE_TRIAGE_PREFIX,
  FAKE_CHAT_PREFIX,
} from './test-fakes.js';

describe('FleetGraph E2E (both modes, stable fakes)', () => {
  const app = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testEmail = `fleetgraph-e2e-${testRunId}@ship.local`;
  const orphanTitle = `Payment webhook drops retries ${testRunId}`;
  const secondOrphanTitle = `Search index lags writes ${testRunId}`;
  const chatQuestion = 'What is the current state of this issue?';

  let runtime: FleetRuntime;
  let sessionCookie: string;
  let csrfToken: string;
  let workspaceId: string;
  let userId: string;
  let projectId: string;
  let orphanIssueId: string;
  let secondOrphanIssueId: string;

  /** Seed an unassigned, week-less, backdated issue — a ripe orphan_intake. */
  async function seedOrphanIssue(title: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by, properties)
       VALUES ($1, 'issue', $2, 'workspace', $3, $4)
       RETURNING id`,
      [workspaceId, title, userId, JSON.stringify({ state: 'todo', priority: 'medium' })],
    );
    const issueId: string = rows[0].id;
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'project')`,
      [issueId, projectId],
    );
    // Backdate past ORPHAN_GRACE_SECONDS (90s) — no sleeping in CI, ever.
    await pool.query(
      `UPDATE documents
          SET created_at = NOW() - interval '3 minutes',
              updated_at = NOW() - interval '3 minutes'
        WHERE id = $1`,
      [issueId],
    );
    return issueId;
  }

  beforeAll(async () => {
    // Keep the runtime cron/bus-free (setup.ts sets this too; be explicit).
    process.env.FLEETGRAPH_ENABLED = 'false';

    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`FleetGraph E2E ${testRunId}`],
    );
    workspaceId = workspaceResult.rows[0].id;

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'FleetGraph E2E User')
       RETURNING id`,
      [testEmail],
    );
    userId = userResult.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

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

    const programResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility)
       VALUES ($1, 'program', 'E2E Program', 'workspace')
       RETURNING id`,
      [workspaceId],
    );
    const projectResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, parent_id)
       VALUES ($1, 'project', 'E2E Project', 'workspace', $2)
       RETURNING id`,
      [workspaceId, programResult.rows[0].id],
    );
    projectId = projectResult.rows[0].id;

    orphanIssueId = await seedOrphanIssue(orphanTitle);

    // The seam: real graph + real DB, injected fake models. Also sets the
    // module singleton so POST /api/agent/chat works end-to-end.
    runtime = initFleetGraph(pool, makeFakeModels());
  });

  afterAll(async () => {
    if (workspaceId) {
      // agent_* tables are not covered by setup.ts truncation — clean here.
      await pool.query(`DELETE FROM agent_findings WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM agent_runs WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM agent_credibility WHERE user_id = $1`, [userId]);
      await pool.query(
        `DELETE FROM document_associations
          WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)`,
        [workspaceId],
      );
      await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM workspace_memberships WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    }
  });

  it('proactive mode: sweep surfaces the introduced orphan within the detection window and serves the card', async () => {
    const started = Date.now();
    const result = await runtime.runTrigger({ kind: 'sweep', workspaceId });
    const detectionLatencyMs = Date.now() - started;

    expect(result.path).toBe('finding');
    // In-process detection latency; production adds only the sweep cadence
    // (<= 5 min), so this is comfortably inside the 5-minute window.
    expect(detectionLatencyMs).toBeLessThan(5000);

    const { rows } = await pool.query(
      `SELECT detector, dedup_key, title, body, rule_based_only, resolved_at
         FROM agent_findings
        WHERE workspace_id = $1 AND document_id = $2`,
      [workspaceId, orphanIssueId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].detector).toBe('orphan_intake');
    expect(rows[0].dedup_key).toBe(`orphan_intake:${orphanIssueId}`);
    expect(rows[0].resolved_at).toBeNull();
    // The fake triage model ran (not the rule-based fallback) and was keyed
    // by intent: the title embeds the actual candidate it was sent.
    expect(rows[0].rule_based_only).toBe(false);
    expect(rows[0].title).toContain(FAKE_TRIAGE_PREFIX);
    expect(rows[0].title).toContain(orphanTitle);

    // Run accounting landed.
    const runs = await pool.query(
      `SELECT mode, path FROM agent_runs
        WHERE workspace_id = $1 AND trigger = 'sweep'
        ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    );
    expect(runs.rows[0]).toMatchObject({ mode: 'proactive', path: 'finding' });

    // The card is served to the user through the real authed route.
    const res = await request(app).get('/api/agent/findings').set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    const card = res.body.findings.find(
      (f: { document_id: string }) => f.document_id === orphanIssueId,
    );
    expect(card).toBeDefined();
    expect(card.title).toContain(FAKE_TRIAGE_PREFIX);
    expect(card.document_title).toBe(orphanTitle);
  });

  it('proactive mode: an immediate second sweep is quiet (dedup, no duplicate cards)', async () => {
    const result = await runtime.runTrigger({ kind: 'sweep', workspaceId });
    expect(result.path).toBe('quiet');

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM agent_findings
        WHERE workspace_id = $1 AND document_id = $2`,
      [workspaceId, orphanIssueId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('on-demand mode: context-aware chat returns a grounded response through the real route', async () => {
    const res = await request(app)
      .post('/api/agent/chat')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ doc_type: 'issue', doc_id: orphanIssueId, message: chatQuestion });

    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(false);
    // Grounding proof: the reply embeds the viewed document's title and
    // state as loaded from Postgres by the graph's respond node, plus the
    // user's question — none of which the fake could know a priori.
    expect(res.body.response).toContain(FAKE_CHAT_PREFIX);
    expect(res.body.response).toContain(orphanTitle);
    expect(res.body.response).toContain('state: todo');
    expect(res.body.response).toContain(chatQuestion);
  });

  it('degraded mode: failing models open the breaker, findings still land rule-based, chat answers honestly', async () => {
    // Clear the active findings so the detectors re-candidate, then
    // introduce a fresh orphan for the degraded sweep to catch.
    await pool.query(
      `UPDATE agent_findings
          SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
        WHERE workspace_id = $1 AND resolved_at IS NULL`,
      [workspaceId],
    );
    secondOrphanIssueId = await seedOrphanIssue(secondOrphanTitle);

    // Re-init through the same seam with always-failing models and a
    // threshold-1 breaker: the first triage failure opens the circuit.
    const failingModels = makeFakeModels({ failing: true });
    runtime = initFleetGraph(pool, failingModels);

    const result = await runtime.runTrigger({ kind: 'sweep', workspaceId });
    // Graceful degradation: the LLM died, the deterministic half did not.
    expect(result.path).toBe('degraded');
    expect(failingModels.breaker.state).toBe('open');

    const { rows } = await pool.query(
      `SELECT title, body, rule_based_only FROM agent_findings
        WHERE workspace_id = $1 AND document_id = $2 AND resolved_at IS NULL`,
      [workspaceId, secondOrphanIssueId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rule_based_only).toBe(true);
    expect(rows[0].title).toContain(secondOrphanTitle);
    expect(rows[0].title).not.toContain(FAKE_TRIAGE_PREFIX);

    // Chat while the breaker is open: fail-fast, honest, degraded-flagged.
    const res = await request(app)
      .post('/api/agent/chat')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ doc_type: 'issue', doc_id: secondOrphanIssueId, message: 'Summarize this issue.' });

    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.response).toContain('unavailable');
    expect(res.body.response).not.toContain(FAKE_CHAT_PREFIX);
    // Breaker is still open after the fail-fast chat call.
    expect(failingModels.breaker.state).toBe('open');
  });
});
