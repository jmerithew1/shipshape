/**
 * Fitness tests for the /api/v1 envelope (Week 6, MVP gate A5).
 *
 * Today (foundation slice): every failure path out of the bare router ships
 * the ApiError shape. As the route factory lands, this file grows the full
 * route enumeration: (a) OpenAPI entry, (b) declared scope, (c) ApiError on
 * failure paths, (d) cursor pagination on list endpoints.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createV1Router } from './router.js';
import { ApiError, API_ERROR_CODES, ApiErrorBody } from './errors.js';

function buildApp(register?: Parameters<typeof createV1Router>[0]) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createV1Router(register));
  return app;
}

function assertApiErrorShape(body: unknown): asserts body is ApiErrorBody {
  expect(body).toBeTypeOf('object');
  const b = body as Record<string, unknown>;
  expect(API_ERROR_CODES).toContain(b.code);
  expect(b.message).toBeTypeOf('string');
  expect(b.request_id).toBeTypeOf('string');
  const allowed = new Set(['code', 'message', 'details', 'request_id']);
  for (const key of Object.keys(b)) expect(allowed.has(key), `unexpected key ${key}`).toBe(true);
}

describe('/api/v1 error envelope (fitness)', () => {
  it('unknown paths return 404 in the ApiError shape with a request id header', async () => {
    const res = await request(buildApp()).get('/api/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    assertApiErrorShape(res.body);
    expect(res.body.code).toBe('not_found');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.request_id).toBe(res.headers['x-request-id']);
  });

  it('thrown ApiError ships its own status, code, and details', async () => {
    const app = buildApp((router) => {
      router.get('/boom-scope', (_req, _res, next) => next(ApiError.insufficientScope('documents:write')));
    });
    const res = await request(app).get('/api/v1/boom-scope');
    expect(res.status).toBe(403);
    assertApiErrorShape(res.body);
    expect(res.body.code).toBe('forbidden');
    // 403s must name the missing scope — no opaque "forbidden".
    expect(res.body.message).toContain('documents:write');
    expect(res.body.details).toEqual({ missing_scope: 'documents:write' });
  });

  it('unexpected exceptions become an opaque server_error envelope', async () => {
    const app = buildApp((router) => {
      router.get('/boom-raw', () => {
        throw new Error('secret internal detail');
      });
    });
    const res = await request(app).get('/api/v1/boom-raw');
    expect(res.status).toBe(500);
    assertApiErrorShape(res.body);
    expect(res.body.code).toBe('server_error');
    expect(res.body.message).not.toContain('secret internal detail');
  });

  it('expired-token code is distinct from unauthorized (MVP gate A3)', () => {
    const expired = ApiError.tokenExpired();
    const invalid = ApiError.unauthorized();
    expect(expired.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(expired.code).not.toBe(invalid.code);
    expect(expired.code).toBe('token_expired');
  });
});
