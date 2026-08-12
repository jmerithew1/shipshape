/**
 * Wire types for the Ship public API (/api/v1).
 *
 * These are hand-written on purpose. The alternative — generating them from
 * openapi.json — produces types nobody can read and nobody can defend; the
 * drift risk that generation would have retired is retired instead by the
 * route manifest (manifest.ts) which CI diffs against the spec in both
 * directions.
 *
 * Field names are snake_case because the wire is snake_case. The SDK does not
 * translate casing: a consumer reading `document_type` in the SDK is reading
 * the same identifier they will see in the API docs, the OpenAPI spec, and a
 * curl response.
 */

/** The authenticated principal behind the current access token. */
export interface ShipUser {
  id: string;
  email: string;
  name?: string;
  workspace_id: string;
}

export interface ShipDocument {
  id: string;
  title: string;
  document_type: string;
  state?: string;
  created_at: string;
  updated_at: string;
}

export interface ShipIssue {
  id: string;
  title: string;
  description?: string;
  state?: string;
  status?: string;
  priority?: string;
  assignee_id?: string | null;
  sprint_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShipSprint {
  id: string;
  name: string;
  state?: string;
  start_date?: string | null;
  end_date?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShipWebhook {
  id: string;
  event: string;
  target_url: string;
  active?: boolean;
  created_at: string;
  /** Present exactly once, on the create response. Never recoverable later. */
  secret?: string;
}

export interface ShipWebhookDelivery {
  id: string;
  webhook_id: string;
  event: string;
  status: string;
  attempt?: number;
  response_status?: number | null;
  created_at: string;
}

/**
 * Every list endpoint returns this shape. `next_cursor` is opaque — consumers
 * who use `iterate()` never see it at all (pagination.ts).
 */
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/**
 * Persisted OAuth credentials. `expires_at` is epoch milliseconds (not the
 * `expires_in` seconds the token endpoint returns) so a stored value stays
 * meaningful across process restarts.
 */
export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

/**
 * Parameters accepted by every list endpoint. Declared as a type alias rather
 * than an interface so it carries an implicit index signature and can be
 * handed straight to the query-string builder.
 */
export type ListParams = {
  limit?: number;
  cursor?: string;
};

export type DocumentListParams = ListParams & {
  document_type?: string;
  state?: string;
};

export type IssueListParams = ListParams & {
  state?: string;
  sprint_id?: string;
  assignee_id?: string;
};

export type SprintListParams = ListParams & {
  state?: string;
};

export type DeliveryListParams = ListParams & {
  webhook_id?: string;
  status?: string;
};

export type CreateDocumentInput = {
  title: string;
  document_type: string;
  content?: string;
  state?: string;
};

export type CreateWebhookInput = {
  event: string;
  target_url: string;
};
