/**
 * The public v1 route table.
 *
 * Every route is declared ONCE here: the same call registers the OpenAPI
 * operation and mounts the Express handler, so the published spec and the
 * running server cannot disagree. Adding a route without a scope, without a
 * spec entry, or (for a list) without pagination is not possible — the factory
 * requires all three, and the fitness test re-proves it over the catalog.
 */
import { Router } from 'express';
import { z } from 'zod';
import { createRouteFactory, listEnvelope, validate, type V1RouteDef } from '../../../openapi/route-factory.js';
import { v1Registry, v1RouteCatalog, buildV1Spec } from '../../../openapi/v1-registry.js';
import { createSpecHandler } from '../../../openapi/serve-spec.js';
import { tokenGate } from '../middleware/authn.js';
import { rateLimit } from '../../../ratelimit/middleware.js';
import { requireScope } from '../middleware/scope.js';
import {
  ShipUserSchema,
  DocumentSchema,
  IssueSchema,
  SprintSchema,
  DocumentListQuerySchema,
  IssueListQuerySchema,
  ListQuerySchema,
  IdParamSchema,
  CreateDocumentSchema,
} from './schemas.js';
import {
  handleGetMe,
  handleListDocuments,
  handleGetDocument,
  handleCreateDocument,
  handleListIssues,
  handleGetIssue,
  handleListSprints,
  handleGetSprint,
} from './documents.js';
import {
  WebhookSubscriptionSchema,
  WebhookSubscriptionCreatedSchema,
  WebhookDeliverySchema,
  CreateWebhookSubscriptionSchema,
  WebhookSubscriptionListQuerySchema,
  WebhookDeliveryListQuerySchema,
  WebhookIdParamSchema,
  handleListWebhookSubscriptions,
  handleCreateWebhookSubscription,
  handleDeleteWebhookSubscription,
  handleListWebhookDeliveries,
  handleReplayWebhookDelivery,
} from './webhooks.js';

const defineRoute = createRouteFactory({
  registry: v1Registry,
  catalog: v1RouteCatalog,
  tokenGate,
  requireScope,
});

/**
 * The OpenAPI registry and route catalog are process-wide singletons — there
 * is exactly one published contract per running server. Express routers are
 * not: createApp() is called repeatedly (several route suites build their own
 * app, and so does every integration test). So the first call registers the
 * spec AND mounts; later calls only mount, replaying the same definitions onto
 * the new router. Without this split the factory's duplicate-operationId guard
 * — which is correct and worth keeping — would fire on the second createApp().
 */
let specRegistered = false;
const replayRateLimitGate = rateLimit();

function route(router: Router, def: V1RouteDef): void {
  if (!specRegistered) {
    defineRoute(router, def);
    return;
  }
  router[def.method](
    def.path,
    tokenGate,
    requireScope(def.scope),
    // Must mirror the factory's chain exactly — otherwise the second and later
    // createApp() calls mount routes with no rate limiting.
    replayRateLimitGate,
    ...(def.middleware ?? []),
    validate(def.request),
    def.handler
  );
}

export function registerV1Routes(router: Router): void {
  // Public docs: deliberately unauthenticated so a developer can read the
  // contract before they have a token. Mounted directly (not via the factory)
  // because it is documentation, not a resource.
  router.get('/openapi.json', createSpecHandler(buildV1Spec));

  route(router, {
    method: 'get',
    path: '/me',
    operationId: 'getMe',
    summary: 'Get the authenticated user and the scopes this token carries',
    scope: 'documents:read',
    responses: { 200: { description: 'The authenticated user', schema: ShipUserSchema } },
    handler: handleGetMe,
  });

  route(router, {
    method: 'get',
    path: '/documents',
    operationId: 'listDocuments',
    summary: 'List documents, newest activity first',
    scope: 'documents:read',
    isList: true,
    request: { query: DocumentListQuerySchema },
    responses: { 200: { description: 'A page of documents', schema: listEnvelope(DocumentSchema) } },
    handler: handleListDocuments,
  });

  route(router, {
    method: 'get',
    path: '/documents/:id',
    operationId: 'getDocument',
    summary: 'Get a single document by id',
    scope: 'documents:read',
    request: { params: IdParamSchema },
    responses: { 200: { description: 'The document', schema: DocumentSchema } },
    handler: handleGetDocument,
  });

  route(router, {
    method: 'post',
    path: '/documents',
    operationId: 'createDocument',
    summary: 'Create a document',
    scope: 'documents:write',
    request: { body: CreateDocumentSchema },
    responses: { 201: { description: 'The created document', schema: DocumentSchema } },
    handler: handleCreateDocument,
  });

  route(router, {
    method: 'get',
    path: '/issues',
    operationId: 'listIssues',
    summary: 'List issues, newest activity first',
    scope: 'issues:read',
    isList: true,
    request: { query: IssueListQuerySchema },
    responses: { 200: { description: 'A page of issues', schema: listEnvelope(IssueSchema) } },
    handler: handleListIssues,
  });

  route(router, {
    method: 'get',
    path: '/issues/:id',
    operationId: 'getIssue',
    summary: 'Get a single issue by id',
    scope: 'issues:read',
    request: { params: IdParamSchema },
    responses: { 200: { description: 'The issue', schema: IssueSchema } },
    handler: handleGetIssue,
  });

  route(router, {
    method: 'get',
    path: '/sprints',
    operationId: 'listSprints',
    summary: 'List sprints, newest activity first',
    scope: 'sprints:read',
    isList: true,
    request: { query: ListQuerySchema },
    responses: { 200: { description: 'A page of sprints', schema: listEnvelope(SprintSchema) } },
    handler: handleListSprints,
  });

  route(router, {
    method: 'get',
    path: '/sprints/:id',
    operationId: 'getSprint',
    summary: 'Get a single sprint by id',
    scope: 'sprints:read',
    request: { params: IdParamSchema },
    responses: { 200: { description: 'The sprint', schema: SprintSchema } },
    handler: handleGetSprint,
  });

  // Webhooks. The two /webhooks/deliveries* paths are registered FIRST so
  // Express matches them before the more general /webhooks/:id.
  route(router, {
    method: 'get',
    path: '/webhooks/deliveries',
    operationId: 'listWebhookDeliveries',
    summary: 'List webhook delivery attempts, newest first',
    scope: 'webhooks:manage',
    isList: true,
    request: { query: WebhookDeliveryListQuerySchema },
    responses: { 200: { description: 'A page of delivery attempts', schema: listEnvelope(WebhookDeliverySchema) } },
    handler: handleListWebhookDeliveries,
  });

  route(router, {
    method: 'post',
    path: '/webhooks/deliveries/:id/replay',
    operationId: 'replayWebhookDelivery',
    summary: 'Re-enqueue a delivery, preserving its original idempotency key',
    scope: 'webhooks:manage',
    request: { params: WebhookIdParamSchema },
    responses: { 202: { description: 'The newly enqueued delivery', schema: WebhookDeliverySchema } },
    handler: handleReplayWebhookDelivery,
  });

  route(router, {
    method: 'get',
    path: '/webhooks',
    operationId: 'listWebhooks',
    summary: 'List this app’s webhook subscriptions',
    scope: 'webhooks:manage',
    isList: true,
    request: { query: WebhookSubscriptionListQuerySchema },
    responses: { 200: { description: 'A page of subscriptions', schema: listEnvelope(WebhookSubscriptionSchema) } },
    handler: handleListWebhookSubscriptions,
  });

  route(router, {
    method: 'post',
    path: '/webhooks',
    operationId: 'createWebhook',
    summary: 'Create a webhook subscription; the signing secret is returned exactly once',
    scope: 'webhooks:manage',
    request: { body: CreateWebhookSubscriptionSchema },
    responses: { 201: { description: 'The created subscription, including its one-time signing secret', schema: WebhookSubscriptionCreatedSchema } },
    handler: handleCreateWebhookSubscription,
  });

  route(router, {
    method: 'delete',
    path: '/webhooks/:id',
    operationId: 'deleteWebhook',
    summary: 'Delete a webhook subscription',
    scope: 'webhooks:manage',
    request: { params: WebhookIdParamSchema },
    responses: { 204: { description: 'Deleted' } },
    handler: handleDeleteWebhookSubscription,
  });

  specRegistered = true;
}

/** Re-exported so the fitness test and the SDK-parity test read the same
 * catalog the router was built from. */
export { v1RouteCatalog, buildV1Spec };

/** Zod is re-exported for tests that build ad-hoc schemas against the factory. */
export { z };
