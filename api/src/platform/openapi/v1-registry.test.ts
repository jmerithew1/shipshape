/**
 * v1 registry / generated-spec tests — the drift proof.
 *
 * Three routes are defined through the factory against the REAL v1 registry
 * and REAL v1RouteCatalog (vitest isolates module state per file, so this is
 * a clean singleton), the spec is generated, and every property the SDK and
 * the fitness tests depend on is asserted against the generated document.
 *
 * No database, no authentication: tokenGate/requireScope are injected
 * pass-throughs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import type { OpenAPIObject, OperationObject, PathItemObject } from 'openapi3-ts/oas31';
import { createV1Router } from '../api/v1/router.js';
import { API_ERROR_CODES } from '../api/v1/errors.js';
import { v1Registry, v1RouteCatalog, ApiErrorSchema, buildV1Spec } from './v1-registry.js';
import { createRouteFactory, type V1RouteDef } from './route-factory.js';
import { createSpecHandler } from './serve-spec.js';

const passThrough: express.RequestHandler = (_req, _res, next) => next();

const defineRoute = createRouteFactory({
  registry: v1Registry,
  catalog: v1RouteCatalog,
  tokenGate: passThrough,
  requireScope: () => passThrough,
});

const WidgetSchema = z.object({ id: z.string(), title: z.string() }).openapi('Widget');

const FAKE_ROUTES: V1RouteDef[] = [
  {
    method: 'get',
    path: '/widgets',
    operationId: 'listWidgets',
    summary: 'List widgets',
    scope: 'documents:read',
    isList: true,
    request: { query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().optional() }) },
    responses: { 200: { description: 'A page of widgets', schema: WidgetSchema } },
    handler: (_req, res) => res.status(200).json({ data: [], next_cursor: null }),
  },
  {
    method: 'post',
    path: '/widgets',
    operationId: 'createWidget',
    summary: 'Create a widget',
    scope: 'documents:write',
    request: { body: z.object({ title: z.string().min(1) }) },
    responses: { 201: { description: 'The created widget', schema: WidgetSchema } },
    handler: (_req, res) => res.status(201).json({ id: 'w1', title: 'x' }),
  },
  {
    method: 'get',
    path: '/widgets/:id',
    operationId: 'getWidget',
    summary: 'Fetch one widget',
    scope: 'documents:read',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'The widget', schema: WidgetSchema } },
    handler: (_req, res) => res.status(200).json({ id: 'w1', title: 'x' }),
  },
];

let app: express.Express;
let spec: OpenAPIObject;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createV1Router((router) => {
      // The spec route is intentionally NOT defined through the factory:
      // it is the one public, unauthenticated endpoint (see serve-spec.ts).
      router.get('/openapi.json', createSpecHandler(buildV1Spec));
      for (const def of FAKE_ROUTES) defineRoute(router, def);
    })
  );
  spec = buildV1Spec();
});

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

/** Every [path, method, operation] triple in the document. */
function operations(doc: OpenAPIObject): Array<[string, string, OperationObject]> {
  const out: Array<[string, string, OperationObject]> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = (item as PathItemObject)[method];
      if (op) out.push([path, method, op]);
    }
  }
  return out;
}

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectRefs(child, out);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

function resolveRef(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cursor: unknown = doc;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = decodeURIComponent(rawSegment).replace(/~1/g, '/').replace(/~0/g, '~');
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

function findUndefinedHoles(node: unknown, path = '$', out: string[] = []): string[] {
  if (node === undefined) {
    out.push(path);
  } else if (Array.isArray(node)) {
    node.forEach((child, i) => findUndefinedHoles(child, `${path}[${i}]`, out));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      findUndefinedHoles(value, `${path}.${key}`, out);
    }
  }
  return out;
}

/** The JSON schema an operation's response body resolves to, following $refs. */
function responseSchema(doc: OpenAPIObject, op: OperationObject, status: string): Record<string, unknown> {
  const response = op.responses?.[status] as Record<string, unknown> | undefined;
  expect(response, `missing ${status} response`).toBeDefined();
  const content = (response as { content?: Record<string, { schema?: unknown }> }).content;
  const schema = content?.['application/json']?.schema as Record<string, unknown> | undefined;
  expect(schema, `missing ${status} application/json schema`).toBeDefined();
  const ref = (schema as { $ref?: string }).$ref;
  return (ref ? (resolveRef(doc, ref) as Record<string, unknown>) : schema) as Record<string, unknown>;
}

describe('v1 registry', () => {
  it('registers the bearerAuth security scheme', () => {
    expect(spec.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('publishes ApiError as a component whose code enum matches API_ERROR_CODES', () => {
    const apiError = spec.components?.schemas?.ApiError as Record<string, unknown> | undefined;
    expect(apiError).toBeDefined();
    const properties = apiError?.properties as Record<string, { enum?: string[] }>;
    expect(properties.code?.enum).toEqual([...API_ERROR_CODES]);
    expect(Object.keys(properties).sort()).toEqual(['code', 'details', 'message', 'request_id']);
    expect((apiError?.required as string[]).sort()).toEqual(['code', 'message', 'request_id']);
  });

  it('ApiErrorSchema accepts a real ApiError body and rejects an unknown code', () => {
    expect(
      ApiErrorSchema.safeParse({ code: 'forbidden', message: 'no', request_id: 'r1' }).success
    ).toBe(true);
    expect(
      ApiErrorSchema.safeParse({ code: 'teapot', message: 'no', request_id: 'r1' }).success
    ).toBe(false);
  });

  it('declares the /api/v1 server and the 3.1.0 version', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers).toEqual([{ url: '/api/v1' }]);
  });
});

describe('generated spec vs. route catalog (drift proof)', () => {
  it('registers exactly the three fake routes in the catalog', () => {
    expect(v1RouteCatalog.map((r) => r.operationId)).toEqual([
      'listWidgets',
      'createWidget',
      'getWidget',
    ]);
  });

  it('every catalog entry has a matching paths entry with the same operationId', () => {
    expect(v1RouteCatalog.length).toBeGreaterThan(0);
    for (const route of v1RouteCatalog) {
      const item = spec.paths?.[route.openapiPath];
      expect(item, `no spec path for ${route.openapiPath}`).toBeDefined();
      const op = (item as PathItemObject)[route.method];
      expect(op, `no ${route.method} operation on ${route.openapiPath}`).toBeDefined();
      expect(op?.operationId).toBe(route.operationId);
      expect(op?.summary).toBe(route.summary);
    }
  });

  it('every spec operation traces back to a catalog entry (no orphan spec entries)', () => {
    const catalogKeys = new Set(v1RouteCatalog.map((r) => `${r.method} ${r.openapiPath}`));
    for (const [path, method] of operations(spec)) {
      expect(catalogKeys.has(`${method} ${path}`), `orphan spec entry ${method} ${path}`).toBe(true);
    }
  });

  it('every operation carries bearerAuth security AND x-required-scope', () => {
    const scopes = new Set(v1RouteCatalog.map((r) => r.scope));
    for (const [path, method, op] of operations(spec)) {
      expect(op.security, `${method} ${path} has no security`).toEqual([{ bearerAuth: [] }]);
      const required = (op as Record<string, unknown>)['x-required-scope'];
      expect(typeof required, `${method} ${path} has no x-required-scope`).toBe('string');
      expect(scopes.has(required as string)).toBe(true);
    }
  });

  it('every operation declares 401/403/429/500 referencing the ApiError shape', () => {
    for (const [path, method, op] of operations(spec)) {
      for (const status of ['401', '403', '429', '500']) {
        const schema = responseSchema(spec, op, status);
        expect(schema.type, `${method} ${path} ${status} is not the ApiError object`).toBe('object');
        const properties = schema.properties as Record<string, { enum?: string[] }>;
        expect(Object.keys(properties).sort()).toEqual(['code', 'details', 'message', 'request_id']);
        expect(properties.code?.enum).toEqual([...API_ERROR_CODES]);
      }
    }
  });

  it('operations with request schemas also declare 400, and param routes declare 404', () => {
    const byId = new Map(operations(spec).map(([, , op]) => [op.operationId, op]));
    expect(Object.keys(byId.get('listWidgets')?.responses ?? {})).toContain('400');
    expect(Object.keys(byId.get('createWidget')?.responses ?? {})).toContain('400');
    expect(Object.keys(byId.get('getWidget')?.responses ?? {})).toContain('404');
    expect(Object.keys(byId.get('createWidget')?.responses ?? {})).not.toContain('404');
  });

  it('the list operation 200 schema is the cursor envelope: data + next_cursor', () => {
    const listOp = operations(spec).find(([, , op]) => op.operationId === 'listWidgets')?.[2];
    expect(listOp).toBeDefined();
    const schema = responseSchema(spec, listOp as OperationObject, '200');
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    expect(Object.keys(properties).sort()).toEqual(['data', 'next_cursor']);
    expect(properties.data?.type).toBe('array');
    // OpenAPI 3.1 expresses nullability as a type union, not `nullable: true`.
    expect(properties.next_cursor?.type).toEqual(['string', 'null']);
    expect((schema.required as string[]).sort()).toEqual(['data', 'next_cursor']);
  });

  it('a non-list 2xx schema is NOT wrapped in the envelope', () => {
    const createOp = operations(spec).find(([, , op]) => op.operationId === 'createWidget')?.[2];
    const schema = responseSchema(spec, createOp as OperationObject, '201');
    expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual(['id', 'title']);
  });

  it("path parameters appear as '{id}' path params, not express ':id'", () => {
    expect(Object.keys(spec.paths ?? {})).toContain('/widgets/{id}');
    expect(JSON.stringify(spec)).not.toContain('/widgets/:id');
    const getOp = operations(spec).find(([, , op]) => op.operationId === 'getWidget')?.[2];
    expect(getOp?.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    ]);
  });
});

describe('spec document', () => {
  it('validates against the OpenAPI 3.1 structural schema', () => {
    // Version
    expect(spec.openapi).toMatch(/^3\.1\.\d+$/);

    // Info
    expect(spec.info?.title).toBeTypeOf('string');
    expect(spec.info.title.length).toBeGreaterThan(0);
    expect(spec.info?.version).toBeTypeOf('string');
    expect(spec.info.version.length).toBeGreaterThan(0);

    // Paths
    expect(spec.paths).toBeTypeOf('object');
    expect(Array.isArray(spec.paths)).toBe(false);
    const pathKeys = Object.keys(spec.paths ?? {});
    expect(pathKeys.length).toBeGreaterThan(0);
    for (const key of pathKeys) {
      expect(key.startsWith('/'), `path key ${key} must start with '/'`).toBe(true);
    }

    // Operations
    const ops = operations(spec);
    expect(ops.length).toBeGreaterThan(0);
    const seenOperationIds = new Set<string>();
    for (const [path, method, op] of ops) {
      expect(op.operationId, `${method} ${path} has no operationId`).toBeTypeOf('string');
      expect(seenOperationIds.has(op.operationId as string)).toBe(false);
      seenOperationIds.add(op.operationId as string);
      expect(Object.keys(op.responses ?? {}).length, `${method} ${path} has no responses`).toBeGreaterThan(0);
    }

    // Every $ref resolves inside this document.
    const refs = collectRefs(spec);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/'), `external $ref not allowed: ${ref}`).toBe(true);
      expect(resolveRef(spec, ref), `unresolvable $ref: ${ref}`).toBeDefined();
    }

    // No `undefined` holes: the document must survive a JSON round-trip intact,
    // because that round-trip is exactly what the served spec and the SDK
    // generator consume.
    expect(findUndefinedHoles(spec)).toEqual([]);
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
  });
});

describe('spec route (serve-spec)', () => {
  it('serves the generated document as JSON without a token', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toBe('Ship Public API');
    expect(Object.keys(res.body.paths)).toContain('/widgets');
  });

  it('builds once and serves the identical cached payload', async () => {
    let builds = 0;
    const handler = createSpecHandler(() => {
      builds += 1;
      return buildV1Spec();
    });
    const cacheApp = express();
    cacheApp.get('/openapi.json', handler);

    const first = await request(cacheApp).get('/openapi.json');
    const second = await request(cacheApp).get('/openapi.json');
    expect(builds).toBe(1);
    expect(second.text).toBe(first.text);
  });
});

describe('mounted routes behave (spec and router are the same declaration)', () => {
  it('reaches the list handler and returns the cursor envelope', async () => {
    const res = await request(app).get('/api/v1/widgets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], next_cursor: null });
  });

  it('rejects an invalid create body with the ApiError envelope', async () => {
    const res = await request(app).post('/api/v1/widgets').send({ title: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.request_id).toBeTypeOf('string');
  });

  it("mounts the express ':id' route, not the spec's '{id}' form", async () => {
    const res = await request(app).get('/api/v1/widgets/w1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'w1', title: 'x' });
  });
});
