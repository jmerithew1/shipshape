/**
 * `SdkShipData` — the `ShipData` port over Ship's own public API.
 *
 * This is the Epic-7 path: FleetGraph stops being a privileged in-process
 * reader and becomes a first-party OAuth application. It obtains a token via
 * the **client-credentials grant** (RFC 6749 §4.4 — there is no human at boot
 * to click consent and no browser to redirect), then reads `/api/v1` with the
 * same scope checks, the same rate limits, and the same request-id/audit
 * plumbing any third-party integrator gets. The proof of citizenship is not
 * that the reads work — it is that they are attributable: every request
 * carries the agent's `client_id`.
 *
 * The SDK is imported from its BUILD OUTPUT (`sdk/dist/index.js`), not
 * `sdk/src`. That is forced, not preferred: `@ship/api` sets `rootDir: ./src`,
 * so pulling `sdk/*.ts` into this program makes `tsc` fail with TS6059 for
 * every SDK source file. `api/src/platform/api/v1/sdk-live.test.ts` documents
 * the same constraint at length. Consequence: this path requires
 * `pnpm --filter @ship/sdk build` to have run.
 *
 * ---------------------------------------------------------------------------
 * GAP REGISTER — reads the public API genuinely cannot express today
 * ---------------------------------------------------------------------------
 * No endpoint was invented to paper over these. Each one falls back to the
 * pool implementation and says why. Closing a gap means adding the field or
 * filter to `/api/v1` and deleting the corresponding branch here.
 *
 *   GAP-1  document associations. The issue→project and issue→week links live
 *          in `document_associations`; `/api/v1` exposes only the unrelated
 *          `documents.parent_id` column and no association expansion at all.
 *          Blocks: orphan intake's "has no week" clause, week-slip's entire
 *          issue↔week rollup, and project attribution on every finding.
 *   GAP-2  `properties->>'owner_id'` on project and week documents. The v1
 *          mappers project only state/assignee_id/priority/start_date/
 *          end_date out of `properties`; `owner_id` is dropped. Blocks RACI
 *          recipient resolution (project owner, week owner).
 *   GAP-3  `is_system_generated`. Same cause as GAP-2 — the flag is in
 *          `properties` and is not mapped. Four detectors exclude on it.
 *   GAP-4  `due_date`. Also unmapped on issues (sprints get start/end dates,
 *          issues get nothing). Blocks `due_soon_idle` entirely.
 *   GAP-5  workspace week anchoring. `workspaces.sprint_start_date` and the
 *          issue's `properties->>'sprint_number'` are not exposed, so the
 *          active-week window cannot be computed through the API.
 *   GAP-6  workspace membership and load. There is no `/api/v1/users` or
 *          membership endpoint, so the deterministic lightest-load assignee
 *          proposal cannot be derived from public data.
 *   GAP-7  single-workspace tokens. A client-credentials token is minted for
 *          the app's own `workspace_id` (`platform/oauth/routes.ts`
 *          `handleClientCredentialsGrant`). The sweep iterates every
 *          workspace, so any workspace other than the agent app's own falls
 *          back to the pool. Closing this needs either per-workspace app
 *          registration or a cross-workspace first-party grant.
 *
 * What DOES go over HTTP today: the three "idle in a state" detectors
 * (`stale_issue`, `stuck_review`, `urgent_idle`). Their primary read maps
 * cleanly onto `GET /api/v1/issues?state=…&updated_before=…`, which is not a
 * coincidence — `resources/documents.ts` says `updated_before` was kept as a
 * filter specifically because it "is what the agent's detectors need".
 */
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
import { ShipClient, ShipError } from '../../../sdk/dist/index.js';

/**
 * The SDK's hand-written `IssueListParams` predates `updated_before` and is
 * stale relative to the server's `IssueListQuerySchema`. `toQuery()` forwards
 * every key verbatim, so widening the type here sends the real server param
 * rather than inventing one.
 */
interface AgentIssueListParams {
  limit?: number;
  cursor?: string;
  state?: string;
  assignee_id?: string;
  updated_before?: string;
}

/** Page size for the agent's reads — the API caps `limit` at 100. */
export const AGENT_PAGE_SIZE = 100;

export interface SdkShipDataOptions {
  /** Origin only; the SDK appends `/api/v1`. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Scopes to request; omitted means the app's full registered set. */
  scope?: string;
  /**
   * Pool-backed implementation used for the GAP-1…GAP-7 reads above. Typed as
   * `ShipData & ShipDataGaps` so the dependency is visible in the signature
   * rather than hidden: this path is not yet pool-free, and pretending
   * otherwise would be the dishonest version of this change.
   */
  fallback: ShipData & ShipDataGaps;
  /** Test seam: supply a ready client instead of running the grant. */
  clientFactory?: () => Promise<ShipClient>;
}

export class SdkShipData implements ShipData {
  private client: Promise<ShipClient> | null = null;
  /** The workspace the app's token is bound to (GAP-7), resolved once. */
  private tokenWorkspaceId: Promise<string | null> | null = null;
  private readonly fallback: ShipData & ShipDataGaps;

  constructor(private readonly options: SdkShipDataOptions) {
    this.fallback = options.fallback;
  }

  /**
   * Lazily run the client-credentials grant, once, and cache the client.
   *
   * `initFleetGraph` is synchronous and runs at boot; the grant is not. The
   * token also has a 1 h TTL and — by design for this grant — no refresh
   * token, so `withClient` below re-runs the grant when the API answers 401.
   */
  private getClient(): Promise<ShipClient> {
    if (!this.client) {
      this.client = this.options.clientFactory
        ? this.options.clientFactory()
        : ShipClient.clientCredentials({
            baseUrl: this.options.baseUrl,
            clientId: this.options.clientId,
            clientSecret: this.options.clientSecret,
            ...(this.options.scope ? { scope: this.options.scope } : {}),
          });
    }
    return this.client;
  }

  /** Run a call, re-authenticating once if the access token has expired. */
  private async withClient<T>(fn: (client: ShipClient) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.getClient());
    } catch (err) {
      if (ShipError.is(err) && err.kind === 'auth' && err.status === 401) {
        // The 1 h token lapsed. Discard it and re-run the grant exactly once;
        // a second failure is a real credential problem and must surface.
        this.client = null;
        this.tokenWorkspaceId = null;
        return fn(await this.getClient());
      }
      throw err;
    }
  }

  /**
   * GAP-7: is this workspace the one our token can see?
   *
   * `/me` reports the token's workspace. Any other workspace in the sweep is
   * genuinely unreadable through this credential, so it degrades to the pool
   * rather than silently returning an empty result set — which would look
   * exactly like "no problems found".
   */
  private async servesWorkspace(workspaceId: string): Promise<boolean> {
    if (!this.tokenWorkspaceId) {
      this.tokenWorkspaceId = this.withClient(async (client) => {
        const me = await client.me();
        return me.workspace_id ?? null;
      }).catch(() => null);
    }
    return (await this.tokenWorkspaceId) === workspaceId;
  }

  /** Walk `GET /api/v1/issues` to exhaustion through the SDK's async iterator. */
  private async listIssues(params: AgentIssueListParams): Promise<PublicIssue[]> {
    return this.withClient(async (client) => {
      const out: PublicIssue[] = [];
      const iterator = client.issues.iterate({
        ...params,
        limit: AGENT_PAGE_SIZE,
      } as Parameters<typeof client.issues.iterate>[0]);
      for await (const issue of iterator) {
        out.push(issue as PublicIssue);
      }
      return out;
    });
  }

  /**
   * Resolve a detector's relative idle window against the process clock.
   *
   * `PoolShipData` uses the DB clock (`NOW() - make_interval(...)`); the API
   * takes an absolute `updated_before`. In-process those clocks are the same
   * host, so the boundary is identical in practice; across a network they
   * would differ by the skew, which is why the port speaks in durations and
   * each implementation resolves its own clock (`ship-data.ts` rule 3).
   */
  private static idleBefore(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString();
  }

  /** Fill GAP-1/2/3 for rows that came back over HTTP. */
  private async attribute(ids: string[]): Promise<Map<string, IssueAttribution>> {
    return this.fallback.findIssueAttribution(ids);
  }

  // ---------------------------------------------------------------------
  // Reads served by the public API
  // ---------------------------------------------------------------------

  async findStaleIssues(workspaceId: string, idleDays: number): Promise<ShipIssueRow[]> {
    if (!(await this.servesWorkspace(workspaceId))) {
      return this.fallback.findStaleIssues(workspaceId, idleDays); // GAP-7
    }
    const issues = await this.listIssues({
      state: 'in_progress',
      updated_before: SdkShipData.idleBefore(idleDays),
    });
    const attribution = await this.attribute(issues.map((i) => i.id));
    return issues.map((i) => toIssueRow(i, workspaceId, attribution.get(i.id)));
  }

  async findStuckReviews(workspaceId: string, idleDays: number): Promise<ShipIssueRow[]> {
    if (!(await this.servesWorkspace(workspaceId))) {
      return this.fallback.findStuckReviews(workspaceId, idleDays); // GAP-7
    }
    const issues = await this.listIssues({
      state: 'in_review',
      updated_before: SdkShipData.idleBefore(idleDays),
    });
    const attribution = await this.attribute(issues.map((i) => i.id));
    return issues
      // GAP-3: the system-generated flag is not published, so the exclusion
      // is applied from the attribution read rather than server-side.
      .filter((i) => !attribution.get(i.id)?.isSystemGenerated)
      .map((i) => toIssueRow(i, workspaceId, attribution.get(i.id)));
  }

  async findUrgentIdleIssues(
    workspaceId: string,
    idleDays: number,
  ): Promise<ShipUrgentIdleRow[]> {
    if (!(await this.servesWorkspace(workspaceId))) {
      return this.fallback.findUrgentIdleIssues(workspaceId, idleDays); // GAP-7
    }
    // `priority` is returned on the issue but is not a query filter, and the
    // API has no NOT-IN operator for `state`; both predicates are therefore
    // applied client-side over an `updated_before`-narrowed page walk. This
    // over-fetches relative to the SQL path — an honest cost of the public
    // contract, bounded by the idle window.
    const issues = await this.listIssues({
      updated_before: SdkShipData.idleBefore(idleDays),
    });
    const excluded = new Set(['in_progress', 'in_review', 'done', 'cancelled']);
    const candidates = issues.filter(
      (i) => i.priority === 'urgent' && !excluded.has(i.state ?? ''),
    );
    const attribution = await this.attribute(candidates.map((i) => i.id));
    return candidates
      .filter((i) => !attribution.get(i.id)?.isSystemGenerated) // GAP-3
      .map((i) => ({
        ...toIssueRow(i, workspaceId, attribution.get(i.id)),
        state: i.state ?? null,
      }));
  }

  // ---------------------------------------------------------------------
  // Reads the public API cannot express — see the GAP register above
  // ---------------------------------------------------------------------

  /** GAP-1 (no week association) + GAP-2 + GAP-3. */
  findOrphanCandidates(workspaceId: string, graceSeconds: number): Promise<ShipOrphanRow[]> {
    return this.fallback.findOrphanCandidates(workspaceId, graceSeconds);
  }

  /** GAP-6: no membership or per-user load endpoint exists. */
  findLightestLoadedMember(workspaceId: string): Promise<ShipMemberLoad | null> {
    return this.fallback.findLightestLoadedMember(workspaceId);
  }

  /** GAP-4: `due_date` is not published on issues. */
  findDueSoonIdleIssues(
    workspaceId: string,
    dueWithinHours: number,
    idleDays: number,
  ): Promise<ShipDueSoonRow[]> {
    return this.fallback.findDueSoonIdleIssues(workspaceId, dueWithinHours, idleDays);
  }

  /** GAP-5 (+ GAP-1 for the rollup counts). */
  findActiveWeeks(workspaceId: string): Promise<ShipActiveWeekRow[]> {
    return this.fallback.findActiveWeeks(workspaceId);
  }

  /** GAP-1: week membership is an association, which v1 does not expose. */
  findNotStartedWeekIssues(weekId: string, limit: number): Promise<ShipWeekIssueRow[]> {
    return this.fallback.findNotStartedWeekIssues(weekId, limit);
  }
}

/** The issue shape `/api/v1/issues` actually returns (`toIssue` in v1). */
interface PublicIssue {
  id: string;
  title: string;
  state?: string | null;
  priority?: string | null;
  assignee_id?: string | null;
  created_at: string;
  updated_at: string;
}

function toIssueRow(
  issue: PublicIssue,
  workspaceId: string,
  attribution: IssueAttribution | undefined,
): ShipIssueRow {
  return {
    id: issue.id,
    title: issue.title,
    // Not in the payload: a client-credentials token is bound to exactly one
    // workspace, and `servesWorkspace` has already proven it is this one.
    workspaceId,
    updatedAt: new Date(issue.updated_at),
    assigneeId: issue.assignee_id ?? null,
    projectId: attribution?.projectId ?? null,
    projectOwnerId: attribution?.projectOwnerId ?? null,
  };
}
