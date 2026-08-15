/**
 * Developer-portal data layer.
 *
 * TWO KINDS OF ENDPOINT, ON PURPOSE — and they are fetched differently:
 *
 *   1. INTERNAL, session-authed (`/api/oauth-apps`, `/api/devportal/audit-log`).
 *      These go through the shared `apiGet/apiPost/apiDelete` wrapper, which
 *      attaches the session cookie and the CSRF token. A 401 from these really
 *      does mean the session died, so the wrapper's redirect-to-login is the
 *      behaviour we want.
 *
 *   2. PUBLIC v1 (`/api/v1/webhooks*`). These answer with the ApiError
 *      envelope, not `{success, data}`, and — being a bearer-token surface —
 *      a 401 here means "this portal has no token for the public API", NOT
 *      "your session expired". Routing them through `apiGet` would bounce the
 *      operator to the login screen over an API-auth problem, so reads use a
 *      local fetch and surface the failure in-page instead.
 *
 * `WEBHOOK_BASE` is a single constant for exactly this reason: if the webhook
 * routes land behind a session-authed portal alias instead, repointing the
 * whole feature is a one-line change here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiDelete } from '@/lib/api';

// ── Types ───────────────────────────────────────────────────────────────────

export interface OAuthApp {
  id: string;
  name: string;
  client_id: string;
  client_secret_prefix: string;
  redirect_uris: string[];
  requested_scopes: string[];
  is_first_party: boolean;
  active: boolean;
  created_at: string;
  secret_rotated_at: string | null;
}

export interface ScopeDefinition {
  scope: string;
  description: string;
}

/** The shown-once payload. Deliberately NOT part of any cached query. */
export interface IssuedSecret {
  appName: string;
  clientId: string | null;
  clientSecret: string;
  warning: string;
}

/** Mirrors `SubscriptionView` in api/src/platform/webhooks/service.ts. */
export interface WebhookSubscription {
  id: string;
  event_type: string;
  target_url: string;
  secret_prefix: string;
  active: boolean;
  created_at: string;
}

/**
 * Event types the server accepts today (webhooks/events.ts `EVENT_TYPES`).
 * A UI affordance only — a suggestion list on a free-text field, never a
 * gate. The server's registry stays authoritative, so a type added there
 * still works here before this list catches up.
 */
export const SUGGESTED_EVENT_TYPES = [
  'document.created',
  'document.updated',
  'document.deleted',
  'issue.created',
  'issue.assigned',
  'issue.status_changed',
  'sprint.started',
  'sprint.completed',
];

export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'failed' | 'dead_lettered';

/** Mirrors `DeliveryView` in api/src/platform/webhooks/service.ts. */
export interface WebhookDelivery {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  idempotency_key: string;
  status: DeliveryStatus;
  attempt_number: number;
  response_status: number | null;
  response_excerpt: string | null;
  latency_ms: number | null;
  last_error: string | null;
  replay_of_id: string | null;
  next_attempt_at: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface AuditEntry {
  id: string;
  request_id: string;
  occurred_at: string;
  app_id: string | null;
  client_id: string | null;
  method: string;
  route: string;
  scope_used: string | null;
  status: number;
  latency_ms: number;
}

export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
}

// ── Envelope readers ────────────────────────────────────────────────────────

interface InternalEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

async function readInternal<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as InternalEnvelope<T> | null;
  if (!res.ok || body?.success === false) {
    throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  }
  return body?.data as T;
}

/** v1 answers `{code, message, details?, request_id}` on failure. */
async function readV1<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

/** See the file header: a 401 here is an API-auth problem, not a dead session. */
async function v1Get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' });
  return readV1<T>(res);
}

/** The one place the public webhook surface is named. */
export const WEBHOOK_BASE = '/api/v1/webhooks';

// ── OAuth apps (internal, session-authed) ───────────────────────────────────

export const devPortalKeys = {
  apps: ['devportal', 'apps'] as const,
  scopes: ['devportal', 'scopes'] as const,
  subscriptions: (appId: string | null) => ['devportal', 'subscriptions', appId] as const,
  deliveries: (appId: string | null, cursor: string | null) =>
    ['devportal', 'deliveries', appId, cursor] as const,
  audit: (clientId: string | null, cursor: string | null) =>
    ['devportal', 'audit', clientId, cursor] as const,
};

export function useOAuthApps() {
  return useQuery<OAuthApp[]>({
    queryKey: devPortalKeys.apps,
    queryFn: async () => readInternal<OAuthApp[]>(await apiGet('/api/oauth-apps')),
  });
}

/** Scopes are DATA, fetched from the registry — never a hardcoded list here. */
export function useScopes() {
  return useQuery<ScopeDefinition[]>({
    queryKey: devPortalKeys.scopes,
    queryFn: async () => readInternal<ScopeDefinition[]>(await apiGet('/api/oauth-apps/scopes')),
    staleTime: 5 * 60 * 1000,
  });
}

export interface RegisterAppInput {
  name: string;
  redirect_uris: string[];
  requested_scopes: string[];
}

export function useRegisterApp() {
  const queryClient = useQueryClient();
  return useMutation<IssuedSecret, Error, RegisterAppInput>({
    mutationFn: async (input) => {
      const created = await readInternal<OAuthApp & { client_secret: string; warning: string }>(
        await apiPost('/api/oauth-apps', input)
      );
      return {
        appName: created.name,
        clientId: created.client_id,
        clientSecret: created.client_secret,
        warning: created.warning,
      };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: devPortalKeys.apps }),
  });
}

export function useRotateSecret() {
  const queryClient = useQueryClient();
  return useMutation<IssuedSecret, Error, OAuthApp>({
    mutationFn: async (app) => {
      const rotated = await readInternal<{ client_secret: string; warning: string }>(
        await apiPost(`/api/oauth-apps/${app.id}/rotate-secret`)
      );
      return {
        appName: app.name,
        clientId: app.client_id,
        clientSecret: rotated.client_secret,
        warning: rotated.warning,
      };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: devPortalKeys.apps }),
  });
}

export function useDeactivateApp() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (appId) => {
      await readInternal<unknown>(await apiDelete(`/api/oauth-apps/${appId}`));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: devPortalKeys.apps }),
  });
}

// ── Webhook subscriptions + deliveries (public v1) ──────────────────────────

export function useSubscriptions(appId: string | null) {
  return useQuery<CursorPage<WebhookSubscription>>({
    queryKey: devPortalKeys.subscriptions(appId),
    queryFn: () =>
      v1Get<CursorPage<WebhookSubscription>>(
        `${WEBHOOK_BASE}?app_id=${encodeURIComponent(appId ?? '')}`
      ),
    enabled: !!appId,
    retry: false,
  });
}

export interface CreateSubscriptionInput {
  app_id: string;
  event_type: string;
  target_url: string;
}

/**
 * The signing secret is returned exactly once, and the exact field it arrives
 * in is the route layer's choice (the service calls it `rawSigningSecret`).
 * Normalising here — rather than guessing one name — means the create flow
 * still shows the secret whichever spelling the route ships with, instead of
 * silently swallowing a credential that can never be recovered.
 */
export interface CreatedSubscription {
  subscription: WebhookSubscription;
  signingSecret: string | null;
}

interface RawCreateResponse {
  subscription?: WebhookSubscription;
  signing_secret?: string;
  rawSigningSecret?: string;
  raw_signing_secret?: string;
}

export function useCreateSubscription() {
  const queryClient = useQueryClient();
  return useMutation<CreatedSubscription, Error, CreateSubscriptionInput>({
    mutationFn: async (input) => {
      const body = await readV1<RawCreateResponse & WebhookSubscription>(
        await apiPost(WEBHOOK_BASE, input)
      );
      return {
        subscription: body.subscription ?? body,
        signingSecret:
          body.signing_secret ?? body.rawSigningSecret ?? body.raw_signing_secret ?? null,
      };
    },
    onSuccess: (_data, input) =>
      queryClient.invalidateQueries({ queryKey: devPortalKeys.subscriptions(input.app_id) }),
  });
}

export function useDeleteSubscription(appId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (subscriptionId) => {
      const res = await apiDelete(`${WEBHOOK_BASE}/${subscriptionId}`);
      if (!res.ok) await readV1<unknown>(res);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: devPortalKeys.subscriptions(appId) }),
  });
}

export function useDeliveries(appId: string | null, cursor: string | null) {
  return useQuery<CursorPage<WebhookDelivery>>({
    queryKey: devPortalKeys.deliveries(appId, cursor),
    queryFn: () => {
      const params = new URLSearchParams({ app_id: appId ?? '', limit: '25' });
      if (cursor) params.set('cursor', cursor);
      return v1Get<CursorPage<WebhookDelivery>>(`${WEBHOOK_BASE}/deliveries?${params.toString()}`);
    },
    enabled: !!appId,
    retry: false,
  });
}

export function useReplayDelivery(appId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<WebhookDelivery, Error, string>({
    mutationFn: async (deliveryId) =>
      readV1<WebhookDelivery>(await apiPost(`${WEBHOOK_BASE}/deliveries/${deliveryId}/replay`)),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['devportal', 'deliveries', appId] }),
  });
}

// ── Public audit trail (internal, session-authed) ───────────────────────────

export function useAuditLog(clientId: string | null, cursor: string | null) {
  return useQuery<{ logs: AuditEntry[]; next_cursor: string | null }>({
    queryKey: devPortalKeys.audit(clientId, cursor),
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '25' });
      if (clientId) params.set('client_id', clientId);
      if (cursor) params.set('cursor', cursor);
      return readInternal<{ logs: AuditEntry[]; next_cursor: string | null }>(
        await apiGet(`/api/devportal/audit-log?${params.toString()}`)
      );
    },
    retry: false,
  });
}
