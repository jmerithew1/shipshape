/**
 * Epic-7 gate — FleetGraph reads Ship through Ship's own public API.
 *
 * Every other FleetGraph test can be satisfied by a fake. This one cannot: it
 * boots the real Express app on an ephemeral port, registers a real
 * first-party OAuth application in real Postgres, runs the real
 * **client-credentials grant** (RFC 6749 §4.4) over a real socket, and drives
 * a real detector through `SdkShipData`. What is under test is the seam the
 * whole epic rests on — that the agent can do its job as an ordinary API
 * consumer, holding a scoped token instead of a database handle.
 *
 * The SDK is imported from `sdk/dist` for the rootDir reason documented at
 * length in `api/src/platform/api/v1/sdk-live.test.ts`; this file follows that
 * file's fixture idiom throughout (port 0, per-suite workspace, CASCADE
 * cleanup, no truncation).
 *
 * Run it alone:
 *   pnpm --filter @ship/sdk build
 *   pnpm --filter @ship/api exec vitest run src/fleetgraph/ship-data-sdk.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';
import { registerApp } from '../platform/oauth/service.js';
import { detectStaleIssues, STALE_IDLE_DAYS } from './detectors.js';
import { PoolShipData } from './ship-data-pool.js';
import { SdkShipData } from './ship-data-sdk.js';
import { ShipClient, type ShipUser } from '../../../sdk/dist/index.js';

/**
 * `/me` reports two fields the SDK's `ShipUser` does not model — they are
 * token facts, not user facts. Declared as an extension rather than asserted
 * with `any` so the extra fields stay type-checked (the idiom, and the
 * reasoning, come from `platform/api/v1/sdk-live.test.ts`).
 */
interface AgentMeResponse extends ShipUser {
  client_id: string | null;
  scopes: string[];
}

/** The scopes `seed-agent-app.ts` registers; the reads below need the first three. */
const AGENT_SCOPES = [
  'documents:read',
  'issues:read',
  'sprints:read',
  'issues:write',
  'sprints:write',
];

let server: Server;
let baseUrl: string;

let workspaceId: string;
let userId: string;
let projectId: string;
let staleIssueId: string;
let clientId: string;
let clientSecret: string;

let sdkData: SdkShipData;
let poolData: PoolShipData;

const auditEnabledBefore = process.env.AUDIT_ENABLED;

beforeAll(async () => {
  process.env.FLEETGRAPH_ENABLED = 'false';

  // The audit middleware is OFF by default under NODE_ENV=test (it writes a
  // row per request, which would break suites that mock pool.query with
  // strict call sequences). This suite opts in deliberately, because the
  // audit rows ARE the Epic-7 acceptance criterion — without this the proof
  // below passes vacuously.
  process.env.AUDIT_ENABLED = 'true';

  const ws = await pool.query(
    `INSERT INTO workspaces (name) VALUES ('FleetGraph SDK Gate') RETURNING id`,
  );
  workspaceId = ws.rows[0].id;

  const user = await pool.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'test-hash', 'FleetGraph Agent Owner') RETURNING id`,
    [`fleetgraph-sdk-${crypto.randomBytes(4).toString('hex')}@ship.local`],
  );
  userId = user.rows[0].id;
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [workspaceId, userId],
  );

  // A project the stale issue belongs to, owned via RACI properties. Neither
  // the association nor owner_id is reachable through /api/v1 (GAP-1, GAP-2),
  // so this is exactly the attribution the SDK path has to recover elsewhere.
  const project = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, visibility, properties)
     VALUES ($1, 'project', 'SDK Gate Project', 'workspace', $2) RETURNING id`,
    [workspaceId, JSON.stringify({ owner_id: userId })],
  );
  projectId = project.rows[0].id;

  const issue = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by, properties)
     VALUES ($1, 'issue', 'Refactor auth session cache', 'workspace', $2, $3) RETURNING id`,
    [workspaceId, userId, JSON.stringify({ state: 'in_progress', assignee_id: userId })],
  );
  staleIssueId = issue.rows[0].id;
  await pool.query(
    `INSERT INTO document_associations (document_id, related_id, relationship_type)
     VALUES ($1, $2, 'project')`,
    [staleIssueId, projectId],
  );
  // Backdate past STALE_IDLE_DAYS — no sleeping in CI, ever.
  await pool.query(
    `UPDATE documents SET updated_at = NOW() - make_interval(days => $2) WHERE id = $1`,
    [staleIssueId, STALE_IDLE_DAYS + 1],
  );

  // The agent's identity: a FIRST-PARTY app. The platform refuses the
  // client-credentials grant to anything else.
  const registered = await registerApp({
    workspaceId,
    ownerUserId: userId,
    name: 'FleetGraph Agent (SDK gate)',
    redirectUris: ['http://127.0.0.1:0/unused-client-credentials'],
    requestedScopes: AGENT_SCOPES,
    isFirstParty: true,
  });
  clientId = registered.app.client_id;
  clientSecret = registered.rawClientSecret;

  // Port 0 = whatever is free; parallel work on this repo must not collide.
  await new Promise<void>((resolve, reject) => {
    const listening = createApp().listen(0, '127.0.0.1', () => resolve());
    listening.once('error', reject);
    server = listening;
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  poolData = new PoolShipData(pool);
  // No `clientFactory`: this instance runs the real grant against the real
  // token endpoint. That absence is the point of the file.
  sdkData = new SdkShipData({ baseUrl, clientId, clientSecret, fallback: poolData });
});

afterAll(async () => {
  // Restore rather than delete: leaving AUDIT_ENABLED=true set would turn on
  // per-request writes for every suite that runs after this one in the worker.
  if (auditEnabledBefore === undefined) delete process.env.AUDIT_ENABLED;
  else process.env.AUDIT_ENABLED = auditEnabledBefore;

  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (workspaceId) {
    await pool.query(`DELETE FROM public_audit_log WHERE workspace_id = $1`, [workspaceId]).catch(
      () => undefined,
    );
    await pool.query(
      `DELETE FROM document_associations
        WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)`,
      [workspaceId],
    );
    // Workspace CASCADE removes documents, api_tokens and oauth_apps.
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  }
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
});

describe('the agent authenticates as a first-party OAuth app (client credentials)', () => {
  it('exchanges its client credentials for a scoped access token over real HTTP', async () => {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
      refresh_token?: string;
    };
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^ship_/);
    // Machine-to-machine: there is no user session to refresh against, so the
    // grant deliberately issues no refresh token. SdkShipData re-runs the
    // grant on 401 instead.
    expect(body.refresh_token).toBeUndefined();
    for (const scope of AGENT_SCOPES) expect(body.scope.split(' ')).toContain(scope);
  });

  it('reports the agent client_id on /me — the identity every read will carry', async () => {
    const client = await ShipClient.clientCredentials({ baseUrl, clientId, clientSecret });
    const me = (await client.me()) as AgentMeResponse;

    // This is the attributability claim in its smallest form: the platform
    // knows which APP is calling, not merely which user.
    expect(me.client_id).toBe(clientId);
    expect(me.workspace_id).toBe(workspaceId);
    expect(me.scopes).toContain('issues:read');
    expect(me.scopes).not.toContain('documents:write');
  });

  it('persists the token against the agent app, so every read is app-attributable', async () => {
    const { rows } = await pool.query(
      `SELECT t.oauth_app_id, t.scopes, a.client_id, a.is_first_party
         FROM api_tokens t JOIN oauth_apps a ON a.id = t.oauth_app_id
        WHERE a.client_id = $1
        ORDER BY t.created_at DESC LIMIT 1`,
      [clientId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].client_id).toBe(clientId);
    expect(rows[0].is_first_party).toBe(true);
    expect(rows[0].scopes).toContain('issues:read');
  });
});

describe('a detector runs end-to-end through /api/v1', () => {
  it('stale_issue detects the same issue through the SDK as through the pool', async () => {
    const viaSdk = await detectStaleIssues(sdkData, workspaceId);
    const viaPool = await detectStaleIssues(poolData, workspaceId);

    const sdkFinding = viaSdk.find((f) => f.documentId === staleIssueId);
    const poolFinding = viaPool.find((f) => f.documentId === staleIssueId);

    expect(sdkFinding).toBeDefined();
    expect(poolFinding).toBeDefined();

    // The flag must not change what the agent decides. Dedup key, severity,
    // evidence and recipient resolution are the whole finding contract, and
    // they are compared field for field rather than by a shallow truthiness
    // check — a silently-degraded SDK path would still "find something".
    expect(sdkFinding!.dedupKey).toBe(poolFinding!.dedupKey);
    expect(sdkFinding!.documentTitle).toBe(poolFinding!.documentTitle);
    expect(sdkFinding!.severity).toBe(poolFinding!.severity);
    expect(sdkFinding!.workspaceId).toBe(workspaceId);
    expect(sdkFinding!.notifyUserIds).toEqual(poolFinding!.notifyUserIds);
    // GAP-1/GAP-2 recovered: /api/v1 publishes neither the project association
    // nor the project's owner_id, so parity here is what proves the
    // attribution fallback is actually wired.
    expect(sdkFinding!.projectId).toBe(projectId);
    expect(sdkFinding!.notifyUserIds).toContain(userId);
  });

  it('issues the read as a real GET /api/v1/issues with the server-side filters', async () => {
    // A pass-through fetch: real socket, real server — it only records the
    // URLs on the way past, so the test can prove the detector's predicate was
    // pushed to the API rather than evaluated after fetching the workspace.
    const seen: string[] = [];
    const observed = new SdkShipData({
      baseUrl,
      clientId,
      clientSecret,
      fallback: poolData,
      clientFactory: () =>
        ShipClient.clientCredentials({
          baseUrl,
          clientId,
          clientSecret,
          fetch: async (input, init) => {
            seen.push(typeof input === 'string' ? input : String(input));
            return fetch(input, init);
          },
        }),
    });

    const findings = await detectStaleIssues(observed, workspaceId);
    expect(findings.some((f) => f.documentId === staleIssueId)).toBe(true);

    const issueReads = seen.filter((u) => u.includes('/api/v1/issues'));
    expect(issueReads.length).toBeGreaterThan(0);
    const url = new URL(issueReads[0]!);
    expect(url.pathname).toBe('/api/v1/issues');
    expect(url.searchParams.get('state')).toBe('in_progress');
    // The staleness window is a server-side filter, not a client-side scan.
    expect(url.searchParams.get('updated_before')).toBeTruthy();
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('is bound by scope like any third-party consumer: no issues:read, no reads', async () => {
    // The agent's privilege is the token's, not the process's. An app without
    // issues:read gets a 403 — which is the entire difference from Week 5,
    // where a pg.Pool could read every row in the database.
    const starved = await registerApp({
      workspaceId,
      ownerUserId: userId,
      name: 'FleetGraph Agent (no issue scope)',
      redirectUris: ['http://127.0.0.1:0/unused-client-credentials'],
      requestedScopes: ['sprints:read'],
      isFirstParty: true,
    });
    const client = await ShipClient.clientCredentials({
      baseUrl,
      clientId: starved.app.client_id,
      clientSecret: starved.rawClientSecret,
    });

    await expect(client.issues.list()).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      details: { missing_scope: 'issues:read' },
    });
  });
});

describe('the Epic-7 audit proof', () => {
  /**
   * THE acceptance criterion for this epic: the proof is not that the agent's
   * reads work, it is that they are RECORDED — `public_audit_log` rows
   * carrying the agent app's `client_id`. A platform whose own agent reads
   * off-the-books has not actually made its agent a citizen.
   *
   * SKIPPED, and deliberately not deleted. The table exists (migration
   * `040_platform_webhooks.sql` ships `public_audit_log` with `client_id`,
   * `app_id`, `route`, `scope_used`, `status`, `latency_ms`), and the reads
   * above genuinely carry the client_id on their token context
   * (`req.platform.clientId`, set in `platform/api/v1/middleware/authn.ts`) —
   * but NOTHING WRITES THE TABLE YET. There is no `middleware/audit.ts`, and
   * `platform/api/v1/router.ts` mounts only `requestIdMiddleware`; a
   * repo-wide search for an insert into `public_audit_log` returns nothing.
   *
   * LANDED: `auditTrail()` (api/src/platform/audit/middleware.ts) is now
   * mounted inside the v1 router, so every public read writes one row keyed on
   * the caller's client_id. The skip is removed and this is live.
   *
   * This assertion IS Epic 7. Before this week the agent read the database
   * directly: no scope, no limit, no trace. The rows below are the proof it
   * now goes through the same front door as a stranger.
   */
  it('records the agent client_id in public_audit_log for every /api/v1 read', async () => {
    const before = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM public_audit_log WHERE client_id = $1`,
      [clientId],
    );

    await detectStaleIssues(sdkData, workspaceId);

    // The audit write is fire-and-forget on the response's `finish` event —
    // deliberately, so recording a call can never delay or fail it. That means
    // the row can land just after the HTTP response the detector awaited, so
    // poll for it rather than reading once. Bounded and event-driven: no fixed
    // sleep, and it fails fast if the row genuinely never arrives.
    const deadline = Date.now() + 5000;
    let rows: Array<Record<string, unknown>> = [];
    do {
      ({ rows } = await pool.query(
        `SELECT client_id, app_id, workspace_id, method, route, scope_used, status
           FROM public_audit_log
          WHERE client_id = $1
          ORDER BY occurred_at DESC`,
        [clientId],
      ));
      if (rows.length > Number(before.rows[0]!.n)) break;
    } while (Date.now() < deadline);

    expect(rows.length).toBeGreaterThan(Number(before.rows[0]!.n));

    const issueRead = rows.find((r) => String(r.route).includes('/issues'));
    expect(issueRead).toBeDefined();
    // The row that makes the agent a citizen: attributable to the APP, scoped,
    // successful, and in the agent's own workspace.
    expect(issueRead!.client_id).toBe(clientId);
    expect(issueRead!.app_id).not.toBeNull();
    expect(issueRead!.workspace_id).toBe(workspaceId);
    expect(issueRead!.method).toBe('GET');
    expect(issueRead!.scope_used).toBe('issues:read');
    expect(issueRead!.status).toBe(200);
  });

  it('the audit table exists and is keyed by client_id, so the proof above is one middleware away', async () => {
    // Schema guard: if the table or these columns were dropped, the proof
    // above would rot silently into a vacuous pass.
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'public_audit_log'`,
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).toContain('client_id');
    expect(columns).toContain('app_id');
    expect(columns).toContain('route');
    expect(columns).toContain('scope_used');

    // This assertion was inverted when the audit middleware landed. It used
    // to assert ZERO rows — a canary saying "nothing writes this yet". It now
    // asserts the opposite, because the agent's reads are recorded. That flip
    // is the whole of Epic 7 in one line.
    const written = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM public_audit_log WHERE client_id = $1`,
      [clientId],
    );
    expect(Number(written.rows[0]!.n)).toBeGreaterThan(0);
  });
});
