/**
 * Route-factory behaviour tests.
 *
 * These use a LOCAL registry + catalog (not the v1 singletons) so each case
 * gets a clean slate — the duplicate-detection tests would otherwise depend
 * on what other tests registered first.
 *
 * tokenGate/requireScope are injected pass-throughs: this file tests the
 * factory's wiring, not authentication (which another module owns). No
 * database is involved.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { createV1Router } from '../api/v1/router.js';
import { API_ERROR_CODES } from '../api/v1/errors.js';
import {
  createRouteFactory,
  listEnvelope,
  toOpenApiPath,
  type RegisteredRoute,
  type V1RouteDef,
} from './route-factory.js';

const passThrough: express.RequestHandler = (_req, _res, next) => next();
const stubDeps = (registry: OpenAPIRegistry, catalog: RegisteredRoute[]) => ({
  registry,
  catalog,
  tokenGate: passThrough,
  requireScope: (_scope: string): express.RequestHandler => passThrough,
});

let registry: OpenAPIRegistry;
let catalog: RegisteredRoute[];
let defineRoute: ReturnType<typeof createRouteFactory>;

beforeEach(() => {
  registry = new OpenAPIRegistry();
  catalog = [];
  defineRoute = createRouteFactory(stubDeps(registry, catalog));
});

/** Mount the given route defs on a real v1 router inside a real app. */
function buildApp(...defs: V1RouteDef[]) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createV1Router((router) => {
      for (const def of defs) defineRoute(router, def);
    })
  );
  return app;
}

const okHandler: express.RequestHandler = (_req, res) => {
  res.status(200).json({ ok: true });
};

function routeDef(overrides: Partial<V1RouteDef> = {}): V1RouteDef {
  return {
    method: 'get',
    path: '/widgets',
    operationId: 'listWidgets',
    summary: 'List widgets',
    scope: 'documents:read',
    responses: { 200: { description: 'OK' } },
    handler: okHandler,
    ...overrides,
  };
}

/** The registered RouteConfig objects, in registration order. */
function registeredRoutes(reg: OpenAPIRegistry) {
  return reg.definitions.flatMap((d) => (d.type === 'route' ? [d.route] : []));
}

/** The Zod schema a registered response carries for application/json. */
function responseZodSchema(reg: OpenAPIRegistry, status: string, index = 0): z.AnyZodObject {
  const response = registeredRoutes(reg)[index]?.responses[status];
  return (response as unknown as { content: { 'application/json': { schema: z.AnyZodObject } } }).content[
    'application/json'
  ].schema;
}

describe('createRouteFactory — definition-time failures', () => {
  it('throws on a duplicate operationId', () => {
    const router = express.Router();
    defineRoute(router, routeDef());
    expect(() => defineRoute(router, routeDef({ path: '/other-widgets' }))).toThrow(
      /Duplicate operationId 'listWidgets'/
    );
  });

  it('throws on a duplicate method + path', () => {
    const router = express.Router();
    defineRoute(router, routeDef());
    expect(() => defineRoute(router, routeDef({ operationId: 'listWidgetsAgain' }))).toThrow(
      /Duplicate route GET \/widgets/
    );
  });

  it('throws on an unknown scope, naming the known ones', () => {
    const router = express.Router();
    expect(() => defineRoute(router, routeDef({ scope: 'documents:raed' }))).toThrow(
      /Unknown scope: 'documents:raed'/
    );
    // A rejected definition must leave no trace behind.
    expect(catalog).toHaveLength(0);
    expect(registeredRoutes(registry)).toHaveLength(0);
  });

  it('a same-path route with a different method is fine', () => {
    const router = express.Router();
    defineRoute(router, routeDef());
    expect(() =>
      defineRoute(router, routeDef({ method: 'post', operationId: 'createWidget', scope: 'documents:write' }))
    ).not.toThrow();
    expect(catalog).toHaveLength(2);
  });
});

describe('createRouteFactory — spec registration', () => {
  it("converts express ':id' params to OpenAPI '{id}'", () => {
    expect(toOpenApiPath('/documents/:id')).toBe('/documents/{id}');
    expect(toOpenApiPath('/documents/:id/comments/:commentId')).toBe(
      '/documents/{id}/comments/{commentId}'
    );

    defineRoute(
      express.Router(),
      routeDef({
        method: 'get',
        path: '/documents/:id',
        operationId: 'getDocument',
        request: { params: z.object({ id: z.string() }) },
      })
    );

    expect(catalog[0]?.path).toBe('/documents/:id');
    expect(catalog[0]?.openapiPath).toBe('/documents/{id}');
    expect(registeredRoutes(registry)[0]?.path).toBe('/documents/{id}');
  });

  it('records a catalog row carrying method, scope, and isList', () => {
    defineRoute(express.Router(), routeDef({ isList: true }));
    expect(catalog[0]).toEqual({
      method: 'get',
      path: '/widgets',
      openapiPath: '/widgets',
      operationId: 'listWidgets',
      summary: 'List widgets',
      scope: 'documents:read',
      isList: true,
    });
  });

  it('defaults isList to false rather than undefined (the manifest is consumed by tests)', () => {
    defineRoute(express.Router(), routeDef());
    expect(catalog[0]?.isList).toBe(false);
  });

  it('always attaches bearerAuth security and the x-required-scope extension', () => {
    defineRoute(express.Router(), routeDef({ scope: 'issues:read' }));
    const route = registeredRoutes(registry)[0];
    expect(route?.security).toEqual([{ bearerAuth: [] }]);
    expect(route?.['x-required-scope']).toBe('issues:read');
  });

  it('auto-appends 401/403/429/500 to a route that declares none', () => {
    defineRoute(express.Router(), routeDef());
    const responses = registeredRoutes(registry)[0]?.responses ?? {};
    expect(Object.keys(responses).sort()).toEqual(['200', '401', '403', '429', '500']);
  });

  it('adds 400 when request schemas exist and 404 when params exist', () => {
    defineRoute(
      express.Router(),
      routeDef({
        method: 'patch',
        path: '/widgets/:id',
        operationId: 'updateWidget',
        scope: 'documents:write',
        request: { params: z.object({ id: z.string() }), body: z.object({ title: z.string() }) },
      })
    );
    const responses = registeredRoutes(registry)[0]?.responses ?? {};
    expect(Object.keys(responses).sort()).toEqual(['200', '400', '401', '403', '404', '429', '500']);
  });

  it('adds 400 but NOT 404 for a body-only route', () => {
    defineRoute(
      express.Router(),
      routeDef({
        method: 'post',
        path: '/widgets',
        operationId: 'createWidget',
        scope: 'documents:write',
        request: { body: z.object({ title: z.string() }) },
      })
    );
    const responses = registeredRoutes(registry)[0]?.responses ?? {};
    expect(Object.keys(responses)).toContain('400');
    expect(Object.keys(responses)).not.toContain('404');
  });

  it('does not clobber an explicitly declared error response', () => {
    defineRoute(
      express.Router(),
      routeDef({
        responses: {
          200: { description: 'OK' },
          404: { description: 'Custom not-found copy' },
        },
      })
    );
    const responses = registeredRoutes(registry)[0]?.responses ?? {};
    expect(responses['404']).toEqual({ description: 'Custom not-found copy' });
  });
});

describe('listEnvelope', () => {
  it('wraps an item schema in { data, next_cursor }', () => {
    const parsed = listEnvelope(z.object({ id: z.string() })).safeParse({
      data: [{ id: 'a' }],
      next_cursor: null,
    });
    expect(parsed.success).toBe(true);
    expect(listEnvelope(z.object({ id: z.string() })).safeParse({ data: [] }).success).toBe(false);
  });

  it('is applied automatically to an isList 2xx schema', () => {
    defineRoute(
      express.Router(),
      routeDef({ isList: true, responses: { 200: { description: 'OK', schema: z.object({ id: z.string() }) } } })
    );
    expect(Object.keys(responseZodSchema(registry, '200').shape).sort()).toEqual([
      'data',
      'next_cursor',
    ]);
  });

  it('leaves a non-list 2xx schema alone', () => {
    defineRoute(
      express.Router(),
      routeDef({ responses: { 200: { description: 'OK', schema: z.object({ id: z.string() }) } } })
    );
    expect(Object.keys(responseZodSchema(registry, '200').shape)).toEqual(['id']);
  });
});

describe('createRouteFactory — request handling', () => {
  const bodySchema = z.object({ title: z.string().min(1), count: z.number().int() });

  it('rejects an invalid body with the 400 ApiError envelope carrying zod issues', async () => {
    const app = buildApp(
      routeDef({
        method: 'post',
        path: '/widgets',
        operationId: 'createWidget',
        scope: 'documents:write',
        request: { body: bodySchema },
      })
    );

    const res = await request(app).post('/api/v1/widgets').send({ title: '', count: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
    expect(API_ERROR_CODES).toContain(res.body.code);
    expect(res.body.request_id).toBeTypeOf('string');
    expect(res.body.request_id).toBe(res.headers['x-request-id']);

    const issues = res.body.details?.issues as Array<Record<string, unknown>>;
    expect(Array.isArray(issues)).toBe(true);
    // Both failures reported at once, each tagged with where it came from.
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.source)).toEqual(['body', 'body']);
    expect(issues.map((i) => (i.path as string[]).join('.')).sort()).toEqual(['count', 'title']);
    expect(issues.some((i) => i.code === 'invalid_type')).toBe(true);
  });

  it('passes valid input through to the handler, coerced', async () => {
    let seen: unknown;
    const app = buildApp(
      routeDef({
        method: 'post',
        path: '/widgets',
        operationId: 'createWidget',
        scope: 'documents:write',
        request: { body: bodySchema },
        handler: (req, res) => {
          seen = req.body;
          res.status(201).json({ id: 'w1' });
        },
        responses: { 201: { description: 'Created' } },
      })
    );

    const res = await request(app).post('/api/v1/widgets').send({ title: 'hi', count: 2 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'w1' });
    expect(seen).toEqual({ title: 'hi', count: 2 });
  });

  it('validates path params and query, exposing coerced values on req.validated', async () => {
    let validated: unknown;
    const app = buildApp(
      routeDef({
        method: 'get',
        path: '/widgets/:id',
        operationId: 'getWidget',
        request: {
          params: z.object({ id: z.string().uuid() }),
          query: z.object({ limit: z.coerce.number().int().max(100) }),
        },
        handler: (req, res) => {
          validated = req.validated;
          res.status(200).json({ ok: true });
        },
      })
    );

    const bad = await request(app).get('/api/v1/widgets/not-a-uuid?limit=500');
    expect(bad.status).toBe(400);
    const sources = (bad.body.details.issues as Array<{ source: string }>).map((i) => i.source);
    expect(sources.sort()).toEqual(['path', 'query']);

    const good = await request(app).get(
      '/api/v1/widgets/6f4f1b0e-6b6d-4c2f-9a3f-1f2b3c4d5e6f?limit=25'
    );
    expect(good.status).toBe(200);
    expect(validated).toEqual({
      params: { id: '6f4f1b0e-6b6d-4c2f-9a3f-1f2b3c4d5e6f' },
      query: { limit: 25 },
    });
  });

  it('runs tokenGate, requireScope(scope), and extra middleware in order, before the handler', async () => {
    const order: string[] = [];
    const trace =
      (label: string): express.RequestHandler =>
      (_req, _res, next) => {
        order.push(label);
        next();
      };

    const router = express.Router();
    const factory = createRouteFactory({
      registry: new OpenAPIRegistry(),
      catalog: [],
      tokenGate: trace('tokenGate'),
      requireScope: (scope) => trace(`requireScope:${scope}`),
    });
    factory(router, routeDef({ middleware: [trace('extra')], handler: (_req, res) => {
      order.push('handler');
      res.status(200).json({ ok: true });
    } }));

    const app = express();
    app.use(express.json());
    app.use('/api/v1', createV1Router((r) => r.use(router)));

    await request(app).get('/api/v1/widgets');
    expect(order).toEqual(['tokenGate', 'requireScope:documents:read', 'extra', 'handler']);
  });

  it('a route with no request schemas skips validation entirely', async () => {
    const app = buildApp(routeDef());
    const res = await request(app).get('/api/v1/widgets').send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
