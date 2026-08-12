/**
 * @ship/sdk — the typed client for Ship's public API.
 *
 * Zero runtime dependencies by design: global fetch and node:crypto, nothing
 * else. That is what keeps the published bundle inside the <250KB min+gz
 * budget and what makes `pnpm add @ship/sdk` a decision nobody has to audit.
 *
 *   import { ShipClient } from '@ship/sdk';
 *   const ship = new ShipClient({ token, baseUrl: 'https://ship.example.com' });
 *   const me = await ship.me();
 *   for await (const doc of ship.documents.iterate()) console.log(doc.title);
 */

export { ShipClient, DEFAULT_BASE_URL } from './client.js';
export type {
  ShipClientOptions,
  DeviceLoginOptions,
  AuthorizationCodeLoginOptions,
  ClientCredentialsOptions,
} from './client.js';

export { verifyWebhook, SHIP_SIGNATURE_HEADER, DEFAULT_TOLERANCE_SECONDS } from './webhook.js';

export { ShipError, kindForStatus } from './errors.js';
export type { ShipErrorKind, ShipErrorInit, ShipErrorBody } from './errors.js';

export { MemoryTokenStore, FileTokenStore, LocalStorageTokenStore } from './token-store.js';
export type { ITokenStore } from './token-store.js';

export { paginate, collect } from './pagination.js';
export type { CursorPage, FetchPage } from './pagination.js';

export { DocumentsClient, IssuesClient, SprintsClient, WebhooksClient } from './resources.js';

export { SDK_ROUTE_MANIFEST, SDK_ROUTES, withPathParam } from './manifest.js';
export type { RouteManifestEntry, SdkOperationId } from './manifest.js';

export type { RateLimitInfo, HttpResponse } from './http.js';

export type {
  ShipUser,
  ShipDocument,
  ShipIssue,
  ShipSprint,
  ShipWebhook,
  ShipWebhookDelivery,
  Page,
  Tokens,
  ListParams,
  DocumentListParams,
  IssueListParams,
  SprintListParams,
  DeliveryListParams,
  CreateDocumentInput,
  CreateWebhookInput,
} from './types.js';
