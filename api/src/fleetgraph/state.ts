/**
 * FleetGraph state. Parallel fetch nodes write DISTINCT keys (issues, weeks,
 * activity) — LangGraph superstep semantics throw on same-key writes without
 * a reducer (plan amendment 5c).
 */
import { Annotation } from '@langchain/langgraph';
import type { CandidateFinding, FleetTrigger, RunPath, TriagedFinding } from './types.js';

export const FleetState = Annotation.Root({
  trigger: Annotation<FleetTrigger>,
  mode: Annotation<'proactive' | 'on_demand'>,
  workspaceId: Annotation<string>,
  projectScope: Annotation<string | null>,

  // fetch stage — one key per parallel node
  issues: Annotation<IssueRow[]>,
  weeks: Annotation<WeekRow[]>,
  recentActivity: Annotation<ActivityRow[]>,

  candidates: Annotation<CandidateFinding[]>,
  triaged: Annotation<TriagedFinding[]>,
  path: Annotation<RunPath>,
  chatResponse: Annotation<string | null>,
  degraded: Annotation<boolean>,
});

export type FleetStateType = typeof FleetState.State;

export interface IssueRow {
  id: string;
  title: string;
  workspace_id: string;
  project_id: string | null;
  week_id: string | null;
  state: string;
  priority: string;
  assignee_id: string | null;
  due_date: string | null;
  is_system_generated: boolean;
  created_at: Date;
  updated_at: Date;
  // Carried so the chat path can filter to what the asking user may see. The
  // detector path ignores them.
  visibility: string;
  created_by: string | null;
}

export interface WeekRow {
  id: string;
  title: string;
  project_id: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  status: string | null;
}

export interface ActivityRow {
  document_id: string;
  field: string;
  changed_at: Date;
}
