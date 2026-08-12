/**
 * The SDK's route manifest — the machine-readable claim "these are exactly
 * the endpoints this client calls".
 *
 * This exists to kill spec drift without codegen. CI diffs this table against
 * openapi.json in BOTH directions:
 *
 *   spec → manifest : the API grew an endpoint the SDK cannot reach
 *   manifest → spec : the SDK calls something the API does not document
 *
 * Either direction fails the build, which is the property generated clients
 * are usually bought for. `operationId` is the join key and must match the
 * spec's operationId exactly.
 *
 * The table is not documentation *about* the resource clients — it is the
 * source they build their URLs from (resources.ts imports SDK_ROUTES), so a
 * method cannot call a path that is absent here. `{id}` is the OpenAPI-style
 * path-parameter placeholder.
 */

export interface RouteManifestEntry {
  operationId: string;
  method: string;
  path: string;
}

export const SDK_ROUTES = {
  getMe: { operationId: 'getMe', method: 'get', path: '/me' },

  listDocuments: { operationId: 'listDocuments', method: 'get', path: '/documents' },
  getDocument: { operationId: 'getDocument', method: 'get', path: '/documents/{id}' },
  createDocument: { operationId: 'createDocument', method: 'post', path: '/documents' },

  listIssues: { operationId: 'listIssues', method: 'get', path: '/issues' },
  getIssue: { operationId: 'getIssue', method: 'get', path: '/issues/{id}' },

  listSprints: { operationId: 'listSprints', method: 'get', path: '/sprints' },
  getSprint: { operationId: 'getSprint', method: 'get', path: '/sprints/{id}' },

  listWebhooks: { operationId: 'listWebhooks', method: 'get', path: '/webhooks' },
  createWebhook: { operationId: 'createWebhook', method: 'post', path: '/webhooks' },
  deleteWebhook: { operationId: 'deleteWebhook', method: 'delete', path: '/webhooks/{id}' },
  listWebhookDeliveries: {
    operationId: 'listWebhookDeliveries',
    method: 'get',
    path: '/webhooks/deliveries',
  },
  replayWebhookDelivery: {
    operationId: 'replayWebhookDelivery',
    method: 'post',
    path: '/webhooks/deliveries/{id}/replay',
  },
} as const satisfies Record<string, RouteManifestEntry>;

export type SdkOperationId = keyof typeof SDK_ROUTES;

/** Flat, iterable form — what the CI fitness test consumes. */
export const SDK_ROUTE_MANIFEST: RouteManifestEntry[] = Object.values(SDK_ROUTES).map((route) => ({
  operationId: route.operationId,
  method: route.method,
  path: route.path,
}));

/** Substitute a single path parameter, URL-encoding the value. */
export function withPathParam(pathTemplate: string, id: string): string {
  return pathTemplate.replace('{id}', encodeURIComponent(id));
}
