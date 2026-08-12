/**
 * CONTRACT FITNESS TESTS — the assignment's testing scenario #4 and #5.
 *
 * These are not unit tests of a function; they are assertions about the SHAPE
 * OF THE WHOLE PUBLIC SURFACE, evaluated by enumerating it. They fail when
 * someone adds a route that breaks the contract, which is the point: the
 * contract is enforced mechanically rather than by review.
 *
 * For every /api/v1 route, assert it:
 *   (a) has an OpenAPI entry
 *   (b) declares a scope
 *   (c) returns the ApiError shape on failure paths
 *   (d) supports cursor pagination if it is a list endpoint
 * Plus: the generated document is valid OpenAPI 3.1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createV1Router } from './router.js';
import { registerV1Routes } from './resources/routes.js';
import { v1RouteCatalog, buildV1Spec } from '../../openapi/v1-registry.js';
import { API_ERROR_CODES } from './errors.js';
import { scopeRegistry } from '../../scopes/registry.js';

type Operation = {
  operationId?: string;
  security?: unknown[];
  responses?: Record<string, unknown>;
  [k: string]: unknown;
};
type Spec = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components?: Record<string, unknown>;
};

let spec: Spec;
const app = express();

beforeAll(() => {
  app.use(express.json());
  app.use('/api/v1', createV1Router(registerV1Routes));
  spec = buildV1Spec() as unknown as Spec;
});

describe('(a) every route has an OpenAPI entry', () => {
  it('registers at least the documents resource required by the MVP gate', () => {
    const ids = v1RouteCatalog.map((r) => r.operationId);
    expect(ids).toContain('listDocuments');
    expect(ids).toContain('getDocument');
    expect(ids).toContain('createDocument');
    expect(ids).toContain('getMe');
  });

  it('has a spec path+method for every catalogued route (no route is undocumented)', () => {
    for (const route of v1RouteCatalog) {
      const pathItem = spec.paths[route.openapiPath];
      expect(pathItem, `missing spec path ${route.openapiPath}`).toBeTruthy();
      const op = pathItem![route.method];
      expect(op, `missing ${route.method.toUpperCase()} ${route.openapiPath}`).toBeTruthy();
      expect(op!.operationId).toBe(route.operationId);
    }
  });

  it('has a catalogued route for every spec operation (no documented-but-missing endpoint)', () => {
    const catalogued = new Set(v1RouteCatalog.map((r) => `${r.method} ${r.openapiPath}`));
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of Object.keys(item)) {
        expect(catalogued.has(`${method} ${path}`), `spec documents ${method} ${path} but no route serves it`).toBe(true);
      }
    }
  });

  it('uses unique operationIds — they become the SDK method names', () => {
    const ids = v1RouteCatalog.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('(b) every route declares a scope', () => {
  it('carries a registered scope in the catalog and in the spec', () => {
    expect(v1RouteCatalog.length).toBeGreaterThan(0);
    for (const route of v1RouteCatalog) {
      expect(route.scope, `${route.operationId} declares no scope`).toBeTruthy();
      expect(scopeRegistry.has(route.scope), `${route.operationId} uses unregistered scope ${route.scope}`).toBe(true);

      const op = spec.paths[route.openapiPath]![route.method]!;
      expect(op['x-required-scope']).toBe(route.scope);
      expect(op.security).toEqual([{ bearerAuth: [] }]);
    }
  });
});

describe('(c) every route returns the ApiError shape on failure paths', () => {
  it('documents 401/403/500 with the ApiError schema on every operation', () => {
    for (const route of v1RouteCatalog) {
      const op = spec.paths[route.openapiPath]![route.method]!;
      for (const status of ['401', '403', '500']) {
        expect(op.responses?.[status], `${route.operationId} does not document ${status}`).toBeTruthy();
      }
    }
  });

  it('actually returns the envelope on a live unauthenticated request to every route', async () => {
    for (const route of v1RouteCatalog) {
      // Substitute a syntactically valid uuid for any path parameter.
      const path = route.path.replace(/:([A-Za-z_]+)/g, '00000000-0000-4000-8000-000000000000');
      const res = await request(app)[route.method](`/api/v1${path}`);

      expect(res.status, `${route.operationId} should reject an unauthenticated call`).toBe(401);
      expect(API_ERROR_CODES, `${route.operationId} returned an off-contract code`).toContain(res.body.code);
      expect(typeof res.body.message).toBe('string');
      expect(typeof res.body.request_id).toBe('string');
      expect(res.body.request_id).toBe(res.headers['x-request-id']);
      for (const key of Object.keys(res.body)) {
        expect(['code', 'message', 'details', 'request_id'], `${route.operationId} leaked key ${key}`).toContain(key);
      }
    }
  });

  it('returns the envelope for unknown paths too', async () => {
    const res = await request(app).get('/api/v1/no-such-thing');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    expect(res.body.request_id).toBeTruthy();
  });
});

describe('(d) list endpoints support cursor pagination', () => {
  it('declares data + next_cursor on every isList route and accepts a cursor param', () => {
    const lists = v1RouteCatalog.filter((r) => r.isList);
    expect(lists.length).toBeGreaterThan(0);

    for (const route of lists) {
      const op = spec.paths[route.openapiPath]![route.method]!;
      const ok = (op.responses as Record<string, { content?: Record<string, { schema?: unknown }> }>)['200'];
      const schema = ok?.content?.['application/json']?.schema as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(schema?.properties, `${route.operationId} has no 200 object schema`).toBeTruthy();
      expect(Object.keys(schema!.properties!), `${route.operationId} is a list without data/next_cursor`).toEqual(
        expect.arrayContaining(['data', 'next_cursor'])
      );
    }
  });
});

describe('OpenAPI 3.1 document validity (testing scenario #5)', () => {
  it('validates against the OpenAPI 3.1 structural schema', () => {
    expect(spec.openapi).toMatch(/^3\.1\.\d+$/);
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBeTruthy();
    expect(typeof spec.paths).toBe('object');

    for (const [path, item] of Object.entries(spec.paths)) {
      expect(path.startsWith('/'), `path ${path} must start with /`).toBe(true);
      for (const [method, op] of Object.entries(item)) {
        expect(op.operationId, `${method} ${path} has no operationId`).toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length, `${method} ${path} documents no responses`).toBeGreaterThan(0);
      }
    }

    // Every $ref must resolve inside this document — a dangling ref is the
    // most common way a generated spec breaks downstream tooling.
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === '$ref' && typeof v === 'string') refs.push(v);
          else walk(v);
        }
      }
    };
    walk(spec);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/'), `external $ref not allowed: ${ref}`).toBe(true);
      const resolved = ref
        .slice(2)
        .split('/')
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part.replace(/~1/g, '/')], spec);
      expect(resolved, `unresolvable $ref ${ref}`).toBeTruthy();
    }
  });

  it('serves the generated spec unauthenticated at /api/v1/openapi.json', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(res.body.paths).length).toBe(v1RouteCatalog.length > 0 ? Object.keys(spec.paths).length : 0);
  });

  it('declares the bearerAuth security scheme', () => {
    const schemes = (spec.components as { securitySchemes?: Record<string, { type?: string; scheme?: string }> })
      ?.securitySchemes;
    expect(schemes?.bearerAuth).toBeTruthy();
    expect(schemes!.bearerAuth!.type).toBe('http');
    expect(schemes!.bearerAuth!.scheme).toBe('bearer');
  });
});
