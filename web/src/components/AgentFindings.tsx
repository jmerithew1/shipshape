import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/cn';
import {
  useAgentFindingsQuery,
  useAgentDispositionMutation,
  AgentFinding,
  AgentDisposition,
} from '@/hooks/useAgentFindingsQuery';
import { useTeamMembersQuery } from '@/hooks/useTeamMembersQuery';

const DETECTOR_LABELS: Record<string, string> = {
  orphan_intake: 'Unassigned intake',
  stale_issue: 'Stale issue',
  stuck_review: 'Stuck review',
  urgent_idle: 'Urgent but idle',
  week_slip: 'Week at risk',
  due_soon_idle: 'Due soon, no activity',
};

export function FindingCard({ finding }: { finding: AgentFinding }) {
  const navigate = useNavigate();
  const disposition = useAgentDispositionMutation();
  const { data: members } = useTeamMembersQuery();
  const [changing, setChanging] = useState(false);
  const [chosenAssignee, setChosenAssignee] = useState('');
  // Checkbox card (week slip): default-checked — agreeing is one click,
  // editing is easy, all-or-nothing is never forced (choice architecture).
  const items = finding.proposed_action?.type === 'move_issues_out_of_week'
    ? finding.proposed_action.items ?? []
    : [];
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(items.map((i) => i.issueId)),
  );

  const toggleItem = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const act = (action: AgentDisposition, assignee_id?: string, issue_ids?: string[]) => {
    disposition.mutate({ findingId: finding.id, action, assignee_id, issue_ids });
  };

  const canExecute = finding.proposed_action?.type === 'assign_issue';
  const isCheckboxCard = items.length > 0;
  const assignable = (members ?? []).filter((m) => m.user_id && !m.isPending);

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        {/* Agent avatar — distinct identity, always attributed */}
        <span className="flex items-center justify-center h-8 w-8 rounded-full flex-shrink-0 bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 text-xs font-bold">
          F
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted uppercase tracking-wide">
              {DETECTOR_LABELS[finding.detector] ?? finding.detector}
            </span>
            {finding.rule_based_only && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/20 text-muted uppercase tracking-wide">
                rule-based (unranked)
              </span>
            )}
          </div>
          <button
            className="text-left text-sm text-foreground mt-0.5 hover:underline"
            onClick={() =>
              finding.document_id && navigate(`/documents/${finding.document_id}`)
            }
          >
            {finding.title}
          </button>
          {finding.body && <p className="text-xs text-muted mt-1">{finding.body}</p>}

          {/* Per-item checkbox list (week-slip multi-issue proposal) */}
          {isCheckboxCard && (
            <div className="mt-2 rounded-lg border border-border divide-y divide-border">
              {items.map((item) => (
                <label
                  key={item.issueId}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-indigo-500/5"
                >
                  <input
                    type="checkbox"
                    checked={checked.has(item.issueId)}
                    onChange={() => toggleItem(item.issueId)}
                    className="accent-indigo-600"
                  />
                  <span className="flex-1 truncate text-foreground">{item.title}</span>
                  <span className="text-muted uppercase text-[10px] tracking-wide">
                    {item.priority} · {item.state}
                  </span>
                </label>
              ))}
              <div className="px-3 py-1.5 text-[11px] text-muted">
                {checked.size} of {items.length} selected — only checked issues move out;
                unchecked stay in the week
              </div>
            </div>
          )}

          {/* Disposition row */}
          <div className="flex flex-wrap items-center gap-2 mt-2">
            {isCheckboxCard && (
              <button
                onClick={() => act('approve', undefined, [...checked])}
                disabled={disposition.isPending || checked.size === 0}
                className="text-xs font-semibold px-3 py-1 rounded-full bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Move {checked.size} out
              </button>
            )}
            {canExecute && !changing && (
              <button
                onClick={() => act('approve')}
                disabled={disposition.isPending}
                className="text-xs font-semibold px-3 py-1 rounded-full bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Approve
              </button>
            )}
            {canExecute && !changing && (
              <button
                onClick={() => setChanging(true)}
                disabled={disposition.isPending}
                className="text-xs font-medium px-3 py-1 rounded-full border border-border hover:bg-background/80"
              >
                Change…
              </button>
            )}
            {changing && (
              <span className="flex items-center gap-1">
                <select
                  value={chosenAssignee}
                  onChange={(e) => setChosenAssignee(e.target.value)}
                  className="text-xs border border-border rounded px-2 py-1 bg-background"
                >
                  <option value="">Choose assignee…</option>
                  {assignable.map((m) => (
                    <option key={m.user_id} value={m.user_id!}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => chosenAssignee && act('change', chosenAssignee)}
                  disabled={!chosenAssignee || disposition.isPending}
                  className="text-xs font-semibold px-2 py-1 rounded-full bg-indigo-600 text-white disabled:opacity-50"
                >
                  Assign
                </button>
                <button
                  onClick={() => setChanging(false)}
                  className="text-xs px-2 py-1 text-muted hover:text-foreground"
                >
                  Cancel
                </button>
              </span>
            )}
            {finding.detector === 'stale_issue' && (
              <button
                onClick={() => act('still_on_it')}
                disabled={disposition.isPending}
                title="Resets the clock. Notifies nobody."
                className="text-xs font-medium px-3 py-1 rounded-full border border-emerald-500/60 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10"
              >
                Still on it
              </button>
            )}
            <button
              onClick={() => act('snooze')}
              disabled={disposition.isPending}
              title="Quiet for 2 business days, then re-checks"
              className="text-xs font-medium px-3 py-1 rounded-full border border-border hover:bg-background/80"
            >
              Snooze
            </button>
            <button
              onClick={() => act('dismiss')}
              disabled={disposition.isPending}
              className="text-xs font-medium px-3 py-1 rounded-full border border-border text-muted hover:bg-background/80"
            >
              Dismiss
            </button>
          </div>
          {disposition.isError && (
            <p className="text-xs text-red-600 dark:text-red-400 mt-1">
              {(disposition.error as Error).message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentFindings() {
  const { data, isLoading, error } = useAgentFindingsQuery();

  if (isLoading || error) return null;
  if (!data?.findings || data.findings.length === 0) return null;

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-indigo-500/20 bg-indigo-500/5">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center h-5 w-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold">
            F
          </span>
          <h2 className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">
            FleetGraph
          </h2>
          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-indigo-700 text-white">
            {data.findings.length}
          </span>
        </div>
        <span className="text-xs text-muted">
          Findings notify once and disappear when resolved
        </span>
      </div>
      <div className={cn('divide-y divide-indigo-500/20 bg-background')}>
        {data.findings.map((f) => (
          <FindingCard key={f.id} finding={f} />
        ))}
      </div>
    </div>
  );
}

export default AgentFindings;
