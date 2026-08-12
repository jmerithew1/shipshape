/**
 * Resource clients — the surface a consumer actually touches.
 *
 * Two rules hold for every method here, and both are tested:
 *
 *  1. It routes through HttpClient. No method builds its own fetch call, so
 *     auth, error translation, refresh and rate-limit reporting are impossible
 *     to forget.
 *  2. Its path comes from SDK_ROUTES (manifest.ts). A method cannot reach an
 *     endpoint the manifest does not declare, which is what makes the manifest
 *     a true statement about the client rather than a comment.
 *
 * `list()` returns the raw `Page<T>` for callers who want to drive cursors
 * themselves (a UI with a "next" button). `iterate()` is the same data as an
 * async generator with the cursor hidden — the form almost every script wants.
 */
import { HttpClient, type QueryParams } from './http.js';
import { SDK_ROUTES, withPathParam } from './manifest.js';
import { paginate } from './pagination.js';
import type {
  CreateDocumentInput,
  CreateWebhookInput,
  DeliveryListParams,
  DocumentListParams,
  IssueListParams,
  ListParams,
  Page,
  ShipDocument,
  ShipIssue,
  ShipSprint,
  ShipWebhook,
  ShipWebhookDelivery,
  SprintListParams,
} from './types.js';

/** Drop undefined/null and anything not URL-representable. */
function toQuery(params: Record<string, unknown> | undefined): QueryParams {
  const query: QueryParams = {};
  if (!params) return query;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      query[key] = value;
    }
  }
  return query;
}

export class DocumentsClient {
  constructor(private readonly http: HttpClient) {}

  list(params?: DocumentListParams): Promise<Page<ShipDocument>> {
    const route = SDK_ROUTES.listDocuments;
    return this.http.send<Page<ShipDocument>>(route.method, route.path, {
      query: toQuery(params),
    });
  }

  iterate(params?: DocumentListParams): AsyncGenerator<ShipDocument> {
    return paginate<ShipDocument>((cursor) => this.list({ ...params, ...(cursor ? { cursor } : {}) }));
  }

  get(id: string): Promise<ShipDocument> {
    const route = SDK_ROUTES.getDocument;
    return this.http.send<ShipDocument>(route.method, withPathParam(route.path, id));
  }

  create(input: CreateDocumentInput): Promise<ShipDocument> {
    const route = SDK_ROUTES.createDocument;
    return this.http.send<ShipDocument>(route.method, route.path, { body: input });
  }
}

export class IssuesClient {
  constructor(private readonly http: HttpClient) {}

  list(params?: IssueListParams): Promise<Page<ShipIssue>> {
    const route = SDK_ROUTES.listIssues;
    return this.http.send<Page<ShipIssue>>(route.method, route.path, { query: toQuery(params) });
  }

  iterate(params?: IssueListParams): AsyncGenerator<ShipIssue> {
    return paginate<ShipIssue>((cursor) => this.list({ ...params, ...(cursor ? { cursor } : {}) }));
  }

  get(id: string): Promise<ShipIssue> {
    const route = SDK_ROUTES.getIssue;
    return this.http.send<ShipIssue>(route.method, withPathParam(route.path, id));
  }
}

export class SprintsClient {
  constructor(private readonly http: HttpClient) {}

  list(params?: SprintListParams): Promise<Page<ShipSprint>> {
    const route = SDK_ROUTES.listSprints;
    return this.http.send<Page<ShipSprint>>(route.method, route.path, { query: toQuery(params) });
  }

  iterate(params?: SprintListParams): AsyncGenerator<ShipSprint> {
    return paginate<ShipSprint>((cursor) => this.list({ ...params, ...(cursor ? { cursor } : {}) }));
  }

  get(id: string): Promise<ShipSprint> {
    const route = SDK_ROUTES.getSprint;
    return this.http.send<ShipSprint>(route.method, withPathParam(route.path, id));
  }
}

export class WebhooksClient {
  constructor(private readonly http: HttpClient) {}

  list(params?: ListParams): Promise<Page<ShipWebhook>> {
    const route = SDK_ROUTES.listWebhooks;
    return this.http.send<Page<ShipWebhook>>(route.method, route.path, { query: toQuery(params) });
  }

  /**
   * The create response is the only time the signing secret is ever returned.
   * Store it now; there is no endpoint that can give it back.
   */
  create(input: CreateWebhookInput): Promise<ShipWebhook> {
    const route = SDK_ROUTES.createWebhook;
    return this.http.send<ShipWebhook>(route.method, route.path, { body: input });
  }

  async delete(id: string): Promise<void> {
    const route = SDK_ROUTES.deleteWebhook;
    await this.http.send<unknown>(route.method, withPathParam(route.path, id));
  }

  deliveries(params?: DeliveryListParams): Promise<Page<ShipWebhookDelivery>> {
    const route = SDK_ROUTES.listWebhookDeliveries;
    return this.http.send<Page<ShipWebhookDelivery>>(route.method, route.path, {
      query: toQuery(params),
    });
  }

  iterateDeliveries(params?: DeliveryListParams): AsyncGenerator<ShipWebhookDelivery> {
    return paginate<ShipWebhookDelivery>((cursor) =>
      this.deliveries({ ...params, ...(cursor ? { cursor } : {}) })
    );
  }

  replay(deliveryId: string): Promise<ShipWebhookDelivery> {
    const route = SDK_ROUTES.replayWebhookDelivery;
    return this.http.send<ShipWebhookDelivery>(route.method, withPathParam(route.path, deliveryId));
  }
}
