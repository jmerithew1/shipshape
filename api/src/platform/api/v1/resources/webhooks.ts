/**
 * Public webhook resources — subscriptions, delivery log, replay.
 *
 * Thin handlers over `platform/webhooks/service.ts`. They own no SQL and no
 * retry logic; they translate HTTP into service calls and `WebhookServiceError`
 * codes into the one public error envelope. The service knows nothing about
 * Express, which is what lets the portal, the CLI, and a future admin surface
 * share it without three copies of the rules.
 *
 * EVERY HANDLER IS SCOPED TO THE CALLING APP. `app_id` comes from
 * `req.platform.oauthAppId` — the token's own app — and is passed into the
 * service on every call, where it lands in the WHERE clause. No handler reads
 * an app id from the client, so one app can never enumerate, replay, or delete
 * another app's webhooks. Personal access tokens have no app and are refused
 * outright: a subscription with no owning app has nowhere to show its delivery
 * log and nobody to rotate its secret.
 *
 * The route table itself lives in routes.ts (the orchestrator wires it) so the
 * OpenAPI operation and the Express mount stay declared in a single call.
 */
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { EVENT_TYPES } from '../../../webhooks/events.js';
import {
  DELIVERY_STATUSES,
  WebhookServiceError,
  createSubscription,
  deleteSubscription,
  listDeliveries,
  listSubscriptions,
  replayDelivery,
} from '../../../webhooks/service.js';

// Idempotent (the library no-ops on an already-extended prototype). Called
// here so this module is import-order independent: a test that imports it
// without touching the v1 registry still gets `.openapi()`.
extendZodWithOpenApi(z);

/**
 * Express 4 does not catch rejected promises from async handlers — a thrown
 * ApiError becomes an unhandled rejection and the request hangs until it
 * times out. Same wrapper, same reason, as resources/documents.ts.
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Derived from the event registry — the published enum cannot drift from the
 *  types the bus actually matches on. */
export const WebhookEventTypeSchema = z.enum(EVENT_TYPES).openapi({
  description: 'One of the event types Ship publishes.',
});

export const WebhookSubscriptionSchema = z
  .object({
    id: z.string().uuid(),
    event_type: z.string(),
    target_url: z.string(),
    active: z.boolean(),
    secret_prefix: z.string().openapi({
      description:
        'The identifying prefix of the signing secret. Enough to recognize which secret a subscription holds; never enough to sign with.',
    }),
    created_at: z.string(),
  })
  .openapi('WebhookSubscription');

export const WebhookSubscriptionCreatedSchema = WebhookSubscriptionSchema.extend({
  signing_secret: z.string().openapi({
    description:
      'The raw signing secret. RETURNED EXACTLY ONCE, in this response only. Ship stores a hash and cannot show it again — lose it and you must recreate the subscription.',
  }),
}).openapi('WebhookSubscriptionCreated');

export const CreateWebhookSubscriptionSchema = z
  .object({
    event_type: WebhookEventTypeSchema,
    target_url: z.string().url().max(2000).openapi({
      description: 'Absolute http(s) URL that will receive POSTed events.',
    }),
  })
  .openapi('CreateWebhookSubscriptionRequest');

export const WebhookDeliverySchema = z
  .object({
    id: z.string().uuid(),
    subscription_id: z.string().uuid(),
    event_id: z.string().uuid(),
    event_type: z.string(),
    idempotency_key: z.string().openapi({
      description:
        'Stable across every retry AND every replay of the same event. Dedupe on this: delivery is at-least-once.',
    }),
    status: z.enum(DELIVERY_STATUSES),
    attempt_number: z.number().int(),
    response_status: z.number().int().nullable(),
    response_excerpt: z.string().nullable(),
    // The exact bytes that were signed and the header they produced. Returned
    // so a client can verify a delivery it reads back from the log — the only
    // path available to a developer whose laptop has no public URL. Re-
    // serializing `payload` would not reproduce these bytes (JSONB normalizes
    // key order), and HMAC is over bytes.
    signed_body: z.string().nullable(),
    signature_header: z.string().nullable().openapi({ example: 't=1715985600,v1=<hex>' }),
    latency_ms: z.number().int().nullable(),
    last_error: z.string().nullable(),
    replay_of_id: z.string().uuid().nullable(),
    next_attempt_at: z.string(),
    created_at: z.string(),
    delivered_at: z.string().nullable(),
  })
  .openapi('WebhookDelivery');

export const WebhookDeliveryListQuerySchema = z.object({
  cursor: z.string().optional().openapi({ description: 'Opaque cursor from a previous response.' }),
  limit: z.coerce.number().int().positive().max(100).optional(),
  subscription_id: z.string().uuid().optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
});

export const WebhookSubscriptionListQuerySchema = z.object({
  event_type: WebhookEventTypeSchema.optional(),
});

export const WebhookIdParamSchema = z.object({ id: z.string().uuid() });

export type CreateWebhookSubscriptionInput = z.infer<typeof CreateWebhookSubscriptionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface AppContext {
  appId: string;
  workspaceId: string;
  userId: string;
}

function requireApp(req: Request): AppContext {
  const ctx = req.platform;
  if (!ctx) throw ApiError.unauthorized('Authentication required');
  if (!ctx.oauthAppId) {
    throw ApiError.forbidden(
      'Webhook subscriptions belong to an OAuth app. Authenticate with an app-issued access token.'
    );
  }
  return { appId: ctx.oauthAppId, workspaceId: ctx.workspaceId, userId: ctx.userId };
}

/**
 * One mapping from domain error code to public envelope, in one place.
 *
 * A duplicate subscription is 400 rather than 409 on purpose: the v1 error
 * envelope publishes a closed set of `code` values, and inventing a status
 * without a matching code would make the spec and the runtime disagree — the
 * exact drift the whole v1 surface is built to prevent. The `details` name the
 * conflicting triple, which is what a client actually needs.
 */
function toApiError(err: unknown): unknown {
  if (!(err instanceof WebhookServiceError)) return err;
  switch (err.code) {
    case 'not_found':
      return ApiError.notFound(err.message, err.details);
    case 'unknown_event_type':
    case 'invalid_target_url':
    case 'duplicate_subscription':
      return ApiError.validation(err.message, err.details);
    default:
      return ApiError.server();
  }
}

async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const handleListWebhookSubscriptions: RequestHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { appId, workspaceId } = requireApp(req);
    const q = (req.validated?.query ?? {}) as { event_type?: (typeof EVENT_TYPES)[number] };
    const subscriptions = await mapErrors(() =>
      listSubscriptions({ appId, workspaceId, eventType: q.event_type })
    );
    // The list envelope, with `next_cursor` permanently null. "Every public
    // list endpoint paginates, no exemptions" is the rule that lets the
    // fitness test enforce pagination mechanically, and an endpoint that
    // returns a bare array is exactly the exemption that erodes it. A
    // subscription set is bounded by the event catalog times a handful of
    // URLs, so there is genuinely never a second page — but the SHAPE is
    // uniform, which means the SDK's iterator works here unchanged and a
    // future paginated implementation is not a breaking change.
    res.json({ data: subscriptions, next_cursor: null });
  }
);

export const handleCreateWebhookSubscription: RequestHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { appId, workspaceId, userId } = requireApp(req);
    const body = req.body as CreateWebhookSubscriptionInput;

    const { subscription, rawSigningSecret } = await mapErrors(() =>
      createSubscription({
        appId,
        workspaceId,
        eventType: body.event_type,
        targetUrl: body.target_url,
        createdBy: userId,
      })
    );

    // The raw secret exists in this response and nowhere else. `no-store`
    // keeps it out of intermediary caches and out of the browser's back/forward
    // cache, which is the difference between "shown once" and "shown once,
    // then again whenever somebody hits back".
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ ...subscription, signing_secret: rawSigningSecret });
  }
);

export const handleDeleteWebhookSubscription: RequestHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { appId, workspaceId } = requireApp(req);
    const id = String(req.params.id);
    const deleted = await mapErrors(() => deleteSubscription({ appId, workspaceId, id }));
    // Same 404 whether it never existed or belongs to another app/workspace.
    if (!deleted) throw ApiError.notFound('Webhook subscription not found');
    res.status(204).end();
  }
);

export const handleListWebhookDeliveries: RequestHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { appId, workspaceId } = requireApp(req);
    // Read the VALIDATED query, never req.query: Zod strips unknown keys
    // rather than rejecting them, so reading the raw object would let an
    // undeclared param reach SQL unvalidated.
    const q = (req.validated?.query ?? {}) as {
      cursor?: string;
      limit?: number;
      subscription_id?: string;
      status?: string;
    };
    const page = await mapErrors(() =>
      listDeliveries({
        appId,
        workspaceId,
        cursor: q.cursor,
        limit: q.limit,
        subscriptionId: q.subscription_id,
        status: q.status,
      })
    );
    res.json(page);
  }
);

export const handleReplayWebhookDelivery: RequestHandler = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { appId, workspaceId } = requireApp(req);
    const id = String(req.params.id);
    const replay = await mapErrors(() => replayDelivery({ id, appId, workspaceId }));
    // 202, not 200: the replay is enqueued, not delivered. The response body
    // is the new delivery row, so the caller can poll it by id.
    res.status(202).json(replay);
  }
);
