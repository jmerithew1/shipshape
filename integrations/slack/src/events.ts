/**
 * The event shapes this integration understands.
 *
 * These are COPIED, deliberately, from Ship's event registry
 * (api/src/platform/webhooks/events.ts) rather than imported. `integrations/**`
 * may import only `@ship/sdk` — enforced by the `no-restricted-imports` rule in
 * eslint.config.mjs — and that rule is the whole point of the exercise: an
 * external integration is a platform citizen precisely because it consumes the
 * public contract and cannot reach into the server's internals for a type.
 *
 * The cost is honest: if Ship adds a field to `document.created`, this file does
 * not learn about it until someone updates it. That is the same cost every real
 * third-party subscriber pays, and it is the reason the payloads are versioned
 * and additive-only. The mitigation is below — nothing here is `strict` about
 * unknown keys, so an added field is ignored, never a crash.
 */

/** The envelope every delivery carries, whatever the type. */
export interface ShipEventEnvelope {
  id: string;
  type: string;
  workspace_id: string;
  /** ISO-8601 UTC. */
  occurred_at: string;
  data: unknown;
}

/** `document.created` payload. Thin by design: ids plus a display title. */
export interface DocumentCreatedPayload {
  document_id: string;
  document_type: string;
  title: string;
  parent_id: string | null;
}

/** `issue.assigned` payload. */
export interface IssueAssignedPayload {
  issue_id: string;
  title: string;
  ticket_number: number | null;
  assignee_id: string | null;
  previous_assignee_id: string | null;
}

/**
 * The two event types this integration renders. Everything else is ignored with
 * a 2xx (see slack.ts) — subscribing broadly and filtering locally is normal.
 */
export const HANDLED_EVENT_TYPES = ['document.created', 'issue.assigned'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * Envelope shape check. This is not schema validation of the whole payload — it
 * is the minimum needed to route. A subscriber that hard-validates every field
 * of a payload it does not control turns every additive server change into an
 * outage on its own side.
 */
export function parseEnvelope(value: unknown): ShipEventEnvelope | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || value['id'].length === 0) return null;
  if (typeof value['type'] !== 'string' || value['type'].length === 0) return null;
  return {
    id: value['id'],
    type: value['type'],
    workspace_id: typeof value['workspace_id'] === 'string' ? value['workspace_id'] : '',
    occurred_at: typeof value['occurred_at'] === 'string' ? value['occurred_at'] : '',
    data: value['data'],
  };
}

export function asDocumentCreated(data: unknown): DocumentCreatedPayload | null {
  if (!isRecord(data)) return null;
  if (typeof data['document_id'] !== 'string') return null;
  if (typeof data['title'] !== 'string') return null;
  return {
    document_id: data['document_id'],
    document_type: typeof data['document_type'] === 'string' ? data['document_type'] : 'document',
    title: data['title'],
    parent_id: isStringOrNull(data['parent_id']) ? data['parent_id'] : null,
  };
}

export function asIssueAssigned(data: unknown): IssueAssignedPayload | null {
  if (!isRecord(data)) return null;
  if (typeof data['issue_id'] !== 'string') return null;
  if (typeof data['title'] !== 'string') return null;
  return {
    issue_id: data['issue_id'],
    title: data['title'],
    ticket_number: typeof data['ticket_number'] === 'number' ? data['ticket_number'] : null,
    assignee_id: isStringOrNull(data['assignee_id']) ? data['assignee_id'] : null,
    previous_assignee_id: isStringOrNull(data['previous_assignee_id'])
      ? data['previous_assignee_id']
      : null,
  };
}
