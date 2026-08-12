/**
 * Drift-proof v1 route factory.
 *
 * ONE call registers the OpenAPI operation AND mounts the Express handler. A
 * route cannot exist without a spec entry, a declared scope, the ApiError
 * failure shape, or (for lists) cursor pagination — not by convention or by
 * review, but because there is no other way to add a route to the v1 router.
 *
 * The four checks the assignment's fitness test makes are therefore
 * structurally guaranteed rather than merely asserted:
 *   (a) spec entry      — registerPath and router.<method> are the same call
 *   (b) declared scope  — `scope` is required and validated against
 *                         scopeRegistry.assertKnown at DEFINITION time
 *   (c) ApiError shape  — 401/403/429/500 (+400/+404) are auto-appended
 *   (d) cursor paging   — `isList` wraps 2xx bodies in listEnvelope()
 *
 * tokenGate and requireScope are INJECTED, not imported: the authn/scope
 * middleware lives behind another module boundary, and injecting it keeps
 * this file (and its tests) free of token verification and database access.
 *
 * Duplicate operationIds and duplicate method+path pairs THROW at definition
 * time. That is a boot-time crash by design — a colliding operationId would
 * otherwise silently drop an operation from the generated SDK.
 */
import type { RequestHandler, Router } from 'express';
import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z, type AnyZodObject, type ZodTypeAny } from 'zod';
import { ApiError } from '../api/v1/errors.js';
import { ApiErrorSchema } from './v1-registry.js';
import { scopeRegistry } from '../scopes/registry.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * Schema-parsed request data, set by the factory's validate() step.
       * Handlers read this instead of re-parsing (and instead of trusting the
       * raw values): it carries Zod coercions, e.g. `limit` as a number.
       */
      validated?: {
        params?: unknown;
        query?: unknown;
        body?: unknown;
      };
    }
  }
}

export type V1Method = 'get' | 'post' | 'patch' | 'delete';

export interface V1RouteDef {
  method: V1Method;
  /** Express-style path, e.g. '/documents/:id'. Converted to '{id}' for the spec. */
  path: string;
  /** Unique across the whole v1 surface; becomes the SDK method name. */
  operationId: string;
  summary: string;
  /** REQUIRED. Validated against scopeRegistry at definition time. */
  scope: string;
  /** Marks a collection endpoint: 2xx bodies get the cursor-pagination envelope. */
  isList?: boolean;
  request?: {
    params?: AnyZodObject;
    query?: AnyZodObject;
    body?: ZodTypeAny;
  };
  responses: Record<number, { description: string; schema?: ZodTypeAny }>;
  handler: RequestHandler;
  middleware?: RequestHandler[];
}

/** One row of the machine-readable route manifest (v1RouteCatalog). */
export interface RegisteredRoute {
  method: V1Method;
  /** Express-style path as mounted, e.g. '/documents/:id'. */
  path: string;
  /** OpenAPI-style path as registered, e.g. '/documents/{id}'. */
  openapiPath: string;
  operationId: string;
  summary: string;
  scope: string;
  isList: boolean;
}

export interface RouteFactoryDeps {
  registry: OpenAPIRegistry;
  catalog: RegisteredRoute[];
  /** Verifies the bearer token and populates the auth context. Injected. */
  tokenGate: RequestHandler;
  /** Builds the per-route scope guard. Injected. */
  requireScope: (scope: string) => RequestHandler;
}

/**
 * The cursor-pagination envelope every list endpoint returns.
 *
 * `next_cursor: null` means "last page". Offset pagination is deliberately
 * absent — it is unstable under concurrent writes, and having exactly one
 * pagination shape is what lets the SDK generate a single `.list()` iterator.
 */
export function listEnvelope<T extends ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    next_cursor: z
      .string()
      .nullable()
      .openapi({ description: 'Opaque cursor for the next page; null on the last page.' }),
  });
}

/** '/documents/:id/comments/:commentId' -> '/documents/{id}/comments/{commentId}' */
export function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function errorResponse(description: string) {
  return { description, content: { 'application/json': { schema: ApiErrorSchema } } };
}

/**
 * Failure responses appended to EVERY operation. Declaring them per-route was
 * the drift vector in the internal spec: routes forgot, and the generated SDK
 * had no typed error union.
 */
/**
 * The registry and the catalog are process-wide singletons, so routes must be
 * defined ONCE per process — at module load — not once per app construction.
 * Building a fresh app per test with a register callback that calls defineRoute
 * is the usual way to trip this; define the routes onto a module-scope Router
 * and have the callback `router.use(...)` it instead.
 */
const DEFINE_ONCE_HINT =
  ' (Routes must be defined once per process, at module load — not once per app/router construction. ' +
  'Define them onto a module-scope Router and mount that Router in the register callback, ' +
  'or pass a fresh registry+catalog to createRouteFactory in tests.)';

const ALWAYS_ERRORS: Record<string, string> = {
  '401': 'Missing, malformed, or expired access token (code: unauthorized | token_expired).',
  '403': 'The token lacks the scope this operation requires (code: forbidden).',
  '429': 'Rate limit exceeded (code: rate_limited); see the Retry-After header.',
  '500': 'Unexpected server error (code: server_error).',
};

export function createRouteFactory(
  deps: RouteFactoryDeps
): (router: Router, def: V1RouteDef) => void {
  const { registry, catalog, tokenGate, requireScope } = deps;

  return function defineRoute(router: Router, def: V1RouteDef): void {
    // ---- definition-time validation (boot-time failure, never a surprise in prod)
    // A typo'd scope would otherwise be an always-403 discovered by a customer.
    scopeRegistry.assertKnown(def.scope);

    if (catalog.some((r) => r.operationId === def.operationId)) {
      throw new Error(
        `Duplicate operationId '${def.operationId}' on ${def.method.toUpperCase()} ${def.path}. ` +
          `operationIds are the generated SDK's method names and must be unique across /api/v1.` +
          DEFINE_ONCE_HINT
      );
    }
    if (catalog.some((r) => r.method === def.method && r.path === def.path)) {
      throw new Error(
        `Duplicate route ${def.method.toUpperCase()} ${def.path}. ` +
          `Express would silently prefer the first registration and the spec would describe only one of them.` +
          DEFINE_ONCE_HINT
      );
    }

    const openapiPath = toOpenApiPath(def.path);
    const isList = def.isList === true;

    // ---- responses: declared 2xx (list-wrapped when appropriate) + auto errors
    const responses: RouteConfig['responses'] = {};

    for (const [statusCode, declared] of Object.entries(def.responses)) {
      const status = Number(statusCode);
      let schema = declared.schema;
      if (schema && isList && status >= 200 && status < 300) {
        schema = listEnvelope(schema);
      }
      responses[statusCode] = schema
        ? { description: declared.description, content: { 'application/json': { schema } } }
        : { description: declared.description };
    }

    for (const [statusCode, description] of Object.entries(ALWAYS_ERRORS)) {
      responses[statusCode] ??= errorResponse(description);
    }
    if (def.request?.params ?? def.request?.query ?? def.request?.body) {
      responses['400'] ??= errorResponse(
        'Request failed schema validation (code: validation_failed); `details.issues` lists the failures.'
      );
    }
    if (def.request?.params) {
      responses['404'] ??= errorResponse('No such resource, or it is outside the token’s workspace (code: not_found).');
    }

    // ---- OpenAPI operation
    const route: RouteConfig = {
      method: def.method,
      path: openapiPath,
      operationId: def.operationId,
      summary: def.summary,
      security: [{ bearerAuth: [] }],
      // Published as an extension so SDK/docs/consent generators can read the
      // scope requirement out of the spec instead of re-deriving it.
      'x-required-scope': def.scope,
      responses,
    };

    if (def.request) {
      route.request = {
        ...(def.request.params ? { params: def.request.params } : {}),
        ...(def.request.query ? { query: def.request.query } : {}),
        ...(def.request.body
          ? { body: { required: true, content: { 'application/json': { schema: def.request.body } } } }
          : {}),
      };
    }

    registry.registerPath(route);

    catalog.push({
      method: def.method,
      path: def.path,
      openapiPath,
      operationId: def.operationId,
      summary: def.summary,
      scope: def.scope,
      isList,
    });

    // ---- Express mount. Same call, same metadata: the spec cannot drift.
    // `router[def.method]` is a union of overloads; the cast picks the one
    // shape we ever use (path + handler chain).
    type Mount = (path: string, ...handlers: RequestHandler[]) => unknown;
    const mount = router[def.method] as unknown as Mount;

    mount.call(
      router,
      def.path,
      tokenGate,
      requireScope(def.scope),
      ...(def.middleware ?? []),
      validate(def.request),
      def.handler
    );
  };
}

interface TaggedIssue {
  source: 'path' | 'query' | 'body';
  [key: string]: unknown;
}

function tag(source: TaggedIssue['source'], issues: readonly z.ZodIssue[]): TaggedIssue[] {
  return issues.map((issue) => ({ source, ...issue }));
}

/**
 * safeParse params/query/body, collect ALL failures, and hand them to the
 * shared error envelope. Never throws and never responds directly — the v1
 * error handler owns the response so the shape stays in one place.
 */
export function validate(request?: V1RouteDef['request']): RequestHandler {
  return (req, _res, next) => {
    if (!request) {
      next();
      return;
    }

    const issues: TaggedIssue[] = [];
    const validated: NonNullable<Express.Request['validated']> = {};

    if (request.params) {
      const parsed = request.params.safeParse(req.params);
      if (parsed.success) validated.params = parsed.data;
      else issues.push(...tag('path', parsed.error.issues));
    }
    if (request.query) {
      const parsed = request.query.safeParse(req.query);
      if (parsed.success) validated.query = parsed.data;
      else issues.push(...tag('query', parsed.error.issues));
    }
    if (request.body) {
      const parsed = request.body.safeParse(req.body);
      if (parsed.success) validated.body = parsed.data;
      else issues.push(...tag('body', parsed.error.issues));
    }

    if (issues.length > 0) {
      next(ApiError.validation('Request validation failed', { issues }));
      return;
    }

    req.validated = validated;
    // Handlers overwhelmingly reach for req.body; keep it, but coerced.
    if (request.body) req.body = validated.body;
    next();
  };
}
