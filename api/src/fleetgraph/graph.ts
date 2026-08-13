/**
 * The FleetGraph StateGraph — one graph, two doors (proactive + chat).
 *
 * Shape (FLEETGRAPH.md §Graph Diagram): ingest → loadContext-equivalent
 * parallel fetch (issues / weeks / activity — distinct state keys) →
 * runDetectors (deterministic, no LLM) → conditional:
 *   - no candidates + proactive → recordQuiet → END   (the $0 path, traced)
 *   - chat mode → respond
 *   - candidates → triage (LLM, breaker-wrapped, degrades to rule-based)
 *     → notify → END
 *
 * The LLM sits BEHIND the detectors: quiet projects never spend a token.
 */
import { StateGraph, START, END } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { Pool } from 'pg';
import { FleetState, type FleetStateType } from './state.js';
import type { FleetModels } from './models.js';
import { BreakerOpenError } from './resilience.js';
import {
  autoResolveCleared,
  detectDueSoonIdle,
  detectOrphanIntake,
  detectStaleIssues,
  detectStuckReview,
  detectUrgentIdle,
  detectWeekSlip,
} from './detectors.js';
import { applyDisclosureAndCredibility } from './attention.js';
import type { ShipData } from './ship-data.js';
import type { TriagedFinding } from './types.js';

const TRIAGE_SYSTEM_PROMPT = `You are FleetGraph, Ship's project-intelligence agent, writing notification cards.

Hard rules:
- Talk about the WORK, never the person. "Issue X has had no activity for 3 days" — never "you haven't touched X".
- Ground every claim in the provided evidence. If a status claim (e.g. "almost done") contradicts the observed state, say what the data shows, neutrally.
- Loss framing for risk: concrete outcomes, not abstract rates. For week_slip findings, lead with what will miss the deadline ("N issues won't make the end of the week"), using evidence.notStartedCount/issueCount — never "completion rate X% at Y% elapsed".
- Self-reported findings (evidence.selfReported = true) are framed as proactive updates, never as failures — prefix "Self-reported:".
- One card per finding: a title (max 90 chars, leads with the plain-English claim) and a body (max 2 sentences: evidence receipt + what happens next, including any forewarned escalation).

Respond in JSON: [{"dedupKey": "...", "title": "...", "body": "..."}] — one entry per finding, nothing else.`;

/** Deterministic titles used whenever the model is unavailable or misses a key. */
function ruleBasedTitle(c: { detector: string; documentTitle: string; evidence: Record<string, unknown> }): string {
  switch (c.detector) {
    case 'orphan_intake':
      return `"${c.documentTitle}" has no assignee and no week`;
    case 'stale_issue':
      return `"${c.documentTitle}" has had no activity for ${String(c.evidence.idleDays ?? 3)} days`;
    case 'stuck_review':
      return `"${c.documentTitle}" has been sitting in review for ${String(c.evidence.idleDays ?? 2)}+ days`;
    case 'urgent_idle':
      return `"${c.documentTitle}" is urgent but nobody has started it`;
    case 'due_soon_idle':
      return `"${c.documentTitle}" is due ${String(c.evidence.dueDate ?? 'soon')} with no recent activity`;
    case 'week_slip':
      return `${String(c.evidence.notStartedCount ?? '?')} issue(s) in "${c.documentTitle}" won't make the end of the week`;
    default:
      return `"${c.documentTitle}" needs attention`;
  }
}

export interface FleetGraphDeps {
  pool: Pool;
  models: FleetModels;
  /** Injectable RNG for the E1 Thompson-sampling gate (seeded in tests). */
  rng?: () => number;
  /**
   * The agent's read boundary onto Ship (Week 6, Epic 7). Defaults to the
   * pool, which `asShipData` adapts into `PoolShipData` — byte-identical to
   * Week 5. `initFleetGraph` supplies `SdkShipData` when `FLEETGRAPH_VIA_SDK`
   * is on, so the detector stage reads through `/api/v1` as a first-party
   * OAuth app instead of straight off the database.
   *
   * Scope note: only the DETECTOR stage crosses this boundary. The three
   * parallel fetch nodes below and the `respond` node load chat context —
   * association-expanded issue rows, week rows, `document_history` activity
   * and document content — none of which `/api/v1` publishes today (GAP-1..5
   * plus the absence of any activity endpoint, see `ship-data-sdk.ts`). They
   * stay on the pool, and that is stated rather than hidden.
   */
  shipData?: ShipData;
}

export function buildFleetGraph({ pool, models, rng = Math.random, shipData }: FleetGraphDeps) {
  const data: ShipData | Pool = shipData ?? pool;
  const graph = new StateGraph(FleetState)
    .addNode('ingestTrigger', async (s: FleetStateType) => ({
      mode: s.trigger.kind === 'chat' ? ('on_demand' as const) : ('proactive' as const),
      workspaceId: s.trigger.workspaceId,
      projectScope:
        s.trigger.kind === 'event'
          ? s.trigger.projectId
          : s.trigger.kind === 'chat'
            ? (s.trigger.projectId ?? null)
            : null,
      degraded: false,
      chatResponse: null,
    }))

    // Parallel fetch supersteps — distinct state keys (amendment 5c).
    .addNode('fetchIssues', async (s: FleetStateType) => {
      const { rows } = await pool.query(
        `SELECT d.id, d.title, d.workspace_id, d.created_at, d.updated_at,
                d.visibility, d.created_by,
                d.properties->>'state' AS state,
                d.properties->>'priority' AS priority,
                d.properties->>'assignee_id' AS assignee_id,
                d.properties->>'due_date' AS due_date,
                COALESCE(d.properties->>'is_system_generated','false')::boolean AS is_system_generated,
                proj.related_id AS project_id,
                wk.related_id AS week_id
           FROM documents d
           LEFT JOIN document_associations proj
                  ON proj.document_id = d.id AND proj.relationship_type = 'project'
           LEFT JOIN document_associations wk
                  ON wk.document_id = d.id AND wk.relationship_type = 'sprint'
          WHERE d.workspace_id = $1 AND d.document_type = 'issue'
            AND d.deleted_at IS NULL AND d.archived_at IS NULL
          ORDER BY d.updated_at DESC
          LIMIT 200`,
        [s.workspaceId],
      );
      return { issues: rows };
    })
    .addNode('fetchWeeks', async (s: FleetStateType) => {
      const { rows } = await pool.query(
        `SELECT d.id, d.title,
                proj.related_id AS project_id,
                d.properties->>'status' AS status,
                NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at
           FROM documents d
           LEFT JOIN document_associations proj
                  ON proj.document_id = d.id AND proj.relationship_type = 'project'
          WHERE d.workspace_id = $1 AND d.document_type = 'sprint'
            AND d.deleted_at IS NULL AND d.archived_at IS NULL
          ORDER BY d.created_at DESC
          LIMIT 50`,
        [s.workspaceId],
      );
      return { weeks: rows };
    })
    .addNode('fetchActivity', async (s: FleetStateType) => {
      const { rows } = await pool.query(
        `SELECT dh.document_id, dh.field, dh.created_at AS changed_at
           FROM document_history dh
           JOIN documents d ON d.id = dh.document_id
          WHERE d.workspace_id = $1 AND dh.created_at > NOW() - INTERVAL '7 days'
          ORDER BY dh.created_at DESC
          LIMIT 300`,
        [s.workspaceId],
      );
      return { recentActivity: rows };
    })

    .addNode('runDetectors', async (s: FleetStateType) => {
      // Housekeeping first: cards whose condition cleared disappear.
      await autoResolveCleared(pool, s.workspaceId);

      const detected = await Promise.all([
        detectOrphanIntake(data, s.workspaceId),
        detectStaleIssues(data, s.workspaceId),
        detectStuckReview(data, s.workspaceId),
        detectUrgentIdle(data, s.workspaceId),
        detectDueSoonIdle(data, s.workspaceId),
        detectWeekSlip(data, s.workspaceId),
      ]);
      const candidates = detected.flat();

      // Dedup against active findings: known-and-notified costs zero tokens.
      if (candidates.length === 0) return { candidates };
      const { rows } = await pool.query(
        `SELECT dedup_key FROM agent_findings
          WHERE workspace_id = $1 AND resolved_at IS NULL`,
        [s.workspaceId],
      );
      const known = new Set(rows.map((r) => r.dedup_key));
      const fresh = candidates.filter((c) => !known.has(c.dedupKey));
      if (fresh.length === 0) return { candidates: fresh };

      // K1 safe disclosure + E1 credibility gate — deterministic policy
      // applied BEFORE the LLM sees anything (attention.ts).
      return { candidates: await applyDisclosureAndCredibility(pool, s.workspaceId, fresh, rng) };
    })

    .addNode('recordQuiet', async () => ({ path: 'quiet' as const }))

    .addNode('triage', async (s: FleetStateType) => {
      const fallback = (): TriagedFinding[] =>
        s.candidates.map((c) => ({
          ...c,
          title: ruleBasedTitle(c),
          body: 'Rule-based (unranked) — the reasoning model was unavailable when this was detected.',
          ruleBasedOnly: true,
        }));

      try {
        const response = await models.breaker.exec(() =>
          models.triage.invoke([
            new SystemMessage(TRIAGE_SYSTEM_PROMPT),
            new HumanMessage(JSON.stringify({ findings: s.candidates })),
          ]),
        );
        const text =
          typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content);
        const parsed = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim()) as Array<{
          dedupKey: string;
          title: string;
          body: string;
        }>;
        const byKey = new Map(parsed.map((p) => [p.dedupKey, p]));
        return {
          triaged: s.candidates.map((c) => {
            const t = byKey.get(c.dedupKey);
            return t
              ? { ...c, title: t.title.slice(0, 200), body: t.body, ruleBasedOnly: false }
              : { ...fallback().find((f) => f.dedupKey === c.dedupKey)! };
          }),
        };
      } catch (err) {
        const degradedPath = err instanceof BreakerOpenError || err instanceof Error;
        return { triaged: fallback(), degraded: degradedPath };
      }
    })

    .addNode('notify', async (s: FleetStateType) => {
      for (const f of s.triaged) {
        await pool.query(
          `INSERT INTO agent_findings
             (workspace_id, project_id, document_id, detector, dedup_key,
              severity, title, body, evidence, notified_user_ids, rule_based_only,
              proposed_action)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (workspace_id, dedup_key) WHERE resolved_at IS NULL
           DO NOTHING`,
          [
            f.workspaceId,
            f.projectId,
            f.documentId,
            f.detector,
            f.dedupKey,
            f.severity,
            f.title,
            f.body,
            JSON.stringify(f.evidence),
            f.notifyUserIds,
            f.ruleBasedOnly,
            f.proposedAction ? JSON.stringify(f.proposedAction) : null,
          ],
        );
      }
      return { path: s.degraded ? ('degraded' as const) : ('finding' as const) };
    })

    .addNode('respond', async (s: FleetStateType) => {
      const trigger = s.trigger;
      if (trigger.kind !== 'chat') return { path: 'chat' as const };

      // Access control (security scan, CWE-639). The chat panel must not become
      // a back door that returns document content the REST read path would 404.
      // Apply the SAME visibility rule GET /api/documents/:id uses:
      // visibility='workspace' OR created_by=caller OR caller is a workspace
      // admin. An inaccessible (or private, or deleted) doc simply loads no
      // content, and `recentIssues` is filtered to what the caller may see.
      const adminRow = await pool.query(
        `SELECT (SELECT role FROM workspace_memberships
                  WHERE workspace_id = $1 AND user_id = $2) = 'admin' AS is_admin`,
        [s.workspaceId, trigger.userId],
      );
      const callerIsAdmin = adminRow.rows[0]?.is_admin === true;

      const doc = await pool.query(
        `SELECT d.title, d.document_type, d.properties, d.updated_at,
                LEFT(d.content::text, 4000) AS content_excerpt
           FROM documents d
          WHERE d.id = $1 AND d.workspace_id = $2 AND d.deleted_at IS NULL
            AND (d.visibility = 'workspace' OR d.created_by = $3 OR $4 = TRUE)`,
        [trigger.docId, s.workspaceId, trigger.userId, callerIsAdmin],
      );

      const visibleIssues = (s.issues ?? []).filter(
        (i) => i.visibility === 'workspace' || i.created_by === trigger.userId || callerIsAdmin,
      );
      try {
        const response = await models.breaker.exec(() =>
          models.chat.invoke([
            new SystemMessage(
              `You are FleetGraph inside Ship, answering in a chat panel scoped to the document the user is viewing. Ground every answer in the provided document and neighborhood data. When a textual status claim contradicts observed state (state field, last-update timestamp), say what the data shows, neutrally. Never invent data. Keep answers under 150 words.`,
            ),
            new HumanMessage(
              JSON.stringify({
                viewing: doc.rows[0] ?? null,
                recentIssues: visibleIssues.slice(0, 30),
                question: trigger.message,
              }),
            ),
          ]),
        );
        const text =
          typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content);
        return { chatResponse: text, path: 'chat' as const };
      } catch {
        return {
          chatResponse:
            "FleetGraph's reasoning model is unavailable right now — I can't answer, and I won't guess. Deterministic monitoring is still running.",
          path: 'degraded' as const,
          degraded: true,
        };
      }
    })

    .addEdge(START, 'ingestTrigger')
    .addEdge('ingestTrigger', 'fetchIssues')
    .addEdge('ingestTrigger', 'fetchWeeks')
    .addEdge('ingestTrigger', 'fetchActivity')
    .addEdge('fetchIssues', 'runDetectors')
    .addEdge('fetchWeeks', 'runDetectors')
    .addEdge('fetchActivity', 'runDetectors')
    .addConditionalEdges('runDetectors', (s: FleetStateType) => {
      if (s.mode === 'on_demand') return 'respond';
      if (s.candidates.length === 0) return 'recordQuiet';
      return 'triage';
    })
    .addEdge('triage', 'notify')
    .addEdge('recordQuiet', END)
    .addEdge('notify', END)
    .addEdge('respond', END);

  return graph.compile();
}
