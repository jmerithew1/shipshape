/**
 * The `ShipData` port — the agent's read boundary onto Ship.
 *
 * Week 5 shipped FleetGraph holding a raw `pg.Pool`: it could read every row
 * in the database, no scope constrained it, no rate limit applied, and nothing
 * recorded what it read. This interface is the seam that ends that. It names
 * — exhaustively — every read the six detectors perform, so the agent can be
 * pointed at Ship's own public API (`/api/v1`) and become a platform citizen
 * with the same scopes, limits and audit trail as any third-party developer.
 *
 * Design rules, deliberately narrow:
 *
 * 1. **One method per real read.** There is no `query(sql)` escape hatch and
 *    no generic filter bag. Each method below corresponds 1:1 to a query that
 *    exists in `detectors.ts` today. If a future detector needs a new read, it
 *    must be named here — which is exactly the pressure that keeps the public
 *    API honest about what it does and does not expose.
 *
 * 2. **Only Ship's own domain data crosses this boundary.** The agent's
 *    private tables (`agent_findings`, `agent_runs`, `agent_credibility`) are
 *    NOT Ship resources and stay on the pool: dedup memory, run accounting and
 *    the E1 credibility posterior are the agent's own state, not a tenant's
 *    project data. Publishing them through `/api/v1` would be a category
 *    error, not an improvement.
 *
 * 3. **Windows are relative, clocks are not.** Detectors mean "quiet for 90
 *    seconds" / "idle for 3 days", never "older than this absolute instant".
 *    The port therefore speaks in *durations* and lets each implementation
 *    resolve its own clock: `PoolShipData` keeps the DB clock (`NOW() -
 *    make_interval(...)`, byte-identical to Week 5), while `SdkShipData`
 *    resolves the process clock into the API's `updated_before` filter. That
 *    split is the reason the flag-OFF path can be proven unchanged.
 *
 * Implementations: `ship-data-pool.ts` (today's SQL, the flag-OFF path) and
 * `ship-data-sdk.ts` (`@ship/sdk` over HTTP, the flag-ON path).
 */
import type { Pool } from 'pg';
import { PoolShipData } from './ship-data-pool.js';

/**
 * An issue as the detectors need to see it.
 *
 * `projectId` / `projectOwnerId` come from `document_associations` + the
 * project document's `properties->>'owner_id'`. Neither is exposed by
 * `/api/v1` today — see the GAP register in `ship-data-sdk.ts`.
 */
export interface ShipIssueRow {
  id: string;
  title: string;
  workspaceId: string;
  /** Last write of any kind — the staleness clock for every idle detector. */
  updatedAt: Date;
  assigneeId: string | null;
  projectId: string | null;
  projectOwnerId: string | null;
}

/** Orphan intake reads no timestamps: the grace window is applied in SQL. */
export interface ShipOrphanRow {
  id: string;
  title: string;
  workspaceId: string;
  projectId: string | null;
  projectOwnerId: string | null;
}

export interface ShipUrgentIdleRow extends ShipIssueRow {
  state: string | null;
}

export interface ShipDueSoonRow extends ShipIssueRow {
  /** `properties->>'due_date'` verbatim — a date string, never a Date. */
  dueDate: string;
}

/** The deterministic assignee proposal: lightest active load wins. */
export interface ShipMemberLoad {
  userId: string;
  activeLoad: number;
}

/** A week (`document_type = 'sprint'`) sitting in the active window. */
export interface ShipActiveWeekRow {
  id: string;
  title: string;
  workspaceId: string;
  sprintNumber: number;
  /** The workspace's week-1 anchor; the elapsed fraction is derived from it. */
  sprintStartDate: Date;
  projectId: string | null;
  projectOwnerId: string | null;
  weekOwnerId: string | null;
  issueCount: number;
  completedCount: number;
}

/** A not-started issue in a week — an item on the scope-cut checkbox card. */
export interface ShipWeekIssueRow {
  id: string;
  title: string;
  state: string | null;
  priority: string | null;
}

/**
 * Every read the detector family performs, and nothing else.
 *
 * The argument lists carry the detector's *thresholds* rather than resolved
 * timestamps on purpose (see design rule 3): the caller states the rule, the
 * implementation states the clock.
 */
export interface ShipData {
  /**
   * Issues past their no-edit grace window with no assignee and no week.
   * Excludes system-generated issues and non-open states.
   */
  findOrphanCandidates(workspaceId: string, graceSeconds: number): Promise<ShipOrphanRow[]>;

  /**
   * The workspace member carrying the fewest `in_progress` / `in_review`
   * issues. The model never picks people; this read does.
   */
  findLightestLoadedMember(workspaceId: string): Promise<ShipMemberLoad | null>;

  /** `in_progress` issues with no write for `idleDays` calendar days. */
  findStaleIssues(workspaceId: string, idleDays: number): Promise<ShipIssueRow[]>;

  /** `in_review` issues with no write for `idleDays` calendar days. */
  findStuckReviews(workspaceId: string, idleDays: number): Promise<ShipIssueRow[]>;

  /** `urgent` issues nobody has started, idle for `idleDays`. */
  findUrgentIdleIssues(workspaceId: string, idleDays: number): Promise<ShipUrgentIdleRow[]>;

  /** Issues due inside `dueWithinHours` and idle for `idleDays`. */
  findDueSoonIdleIssues(
    workspaceId: string,
    dueWithinHours: number,
    idleDays: number,
  ): Promise<ShipDueSoonRow[]>;

  /** Weeks whose `sprint_number` matches the workspace's current window. */
  findActiveWeeks(workspaceId: string): Promise<ShipActiveWeekRow[]>;

  /** Not-started issues in a week, cheapest sacrifice first, capped. */
  findNotStartedWeekIssues(weekId: string, limit: number): Promise<ShipWeekIssueRow[]>;
}

/**
 * Attribution fields that live on an issue's *neighbourhood* rather than on
 * the issue row itself, and which `/api/v1` does not publish today.
 *
 * Kept as a separate interface — not folded into `ShipData` — so the gap is
 * greppable and so `SdkShipData` has to state, in its type, that it still
 * needs a pool for these. When v1 grows association/owner expansion, deleting
 * this interface is the whole migration.
 */
export interface IssueAttribution {
  projectId: string | null;
  projectOwnerId: string | null;
  isSystemGenerated: boolean;
}

export interface ShipDataGaps {
  /** Project + owner + system flag for a set of issues, keyed by issue id. */
  findIssueAttribution(issueIds: string[]): Promise<Map<string, IssueAttribution>>;
}

/**
 * Accept either the port or a raw `pg.Pool`.
 *
 * The Week-5 detector tests call `detectStaleIssues(pool, workspaceId)`
 * directly and are the frozen behavioural contract for this change, so the
 * detectors keep accepting a `Pool` and adapt it here. A `Pool` has `.query`;
 * `PoolShipData` deliberately does not — that is the discriminator.
 */
export function asShipData(source: ShipData | Pool): ShipData {
  return isPool(source) ? new PoolShipData(source) : source;
}

function isPool(source: ShipData | Pool): source is Pool {
  return typeof (source as Pool).query === 'function';
}
