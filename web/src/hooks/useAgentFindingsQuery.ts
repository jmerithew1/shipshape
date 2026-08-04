import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';

export interface AgentFinding {
  id: string;
  detector: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: string;
  title: string;
  body: string | null;
  evidence: Record<string, unknown>;
  proposed_action: {
    type: string;
    issueId?: string;
    assigneeId?: string;
    reason?: string;
  } | null;
  document_id: string | null;
  document_title: string | null;
  ticket_number: number | null;
  rule_based_only: boolean;
  created_at: string;
}

export type AgentDisposition = 'approve' | 'change' | 'dismiss' | 'snooze' | 'still_on_it';

export const agentFindingsKeys = {
  all: ['agent-findings'] as const,
  list: () => [...agentFindingsKeys.all, 'list'] as const,
};

export function useAgentFindingsQuery() {
  return useQuery<{ findings: AgentFinding[] }>({
    queryKey: agentFindingsKeys.list(),
    queryFn: async () => {
      const response = await apiGet('/api/agent/findings');
      if (!response.ok) throw new Error('Failed to fetch agent findings');
      return response.json();
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
}

export function useAgentDispositionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      findingId: string;
      action: AgentDisposition;
      assignee_id?: string;
    }) => {
      const response = await apiPost(`/api/agent/findings/${params.findingId}/disposition`, {
        action: params.action,
        ...(params.assignee_id ? { assignee_id: params.assignee_id } : {}),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Disposition failed');
      }
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentFindingsKeys.all });
    },
  });
}
