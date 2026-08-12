/**
 * Envelope edge cases at the EDGE of the v1 router — failures raised by
 * middleware mounted ABOVE it, which the router's own error handler never
 * sees. Found by the contract audit: a malformed JSON body was returning an
 * Express HTML error page, violating "every public failure ships ApiError".
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../app.js';
import { API_ERROR_CODES } from './errors.js';

const app = createApp();

describe('public envelope survives pre-router failures', () => {
  it('returns the ApiError envelope for a malformed JSON body, not an HTML page', async () => {
    const res = await request(app)
      .post('/api/v1/documents')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer ship_fake')
      .send('{"title": broken}');

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(String(res.text)).not.toContain('<!DOCTYPE html>');
    expect(API_ERROR_CODES).toContain(res.body.code);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.request_id).toBeTruthy();
    expect(res.body.request_id).toBe(res.headers['x-request-id']);
  });

  it('leaves malformed JSON on INTERNAL routes to the existing handler', async () => {
    // The internal API has its own long-standing contract; adding the public
    // envelope must not silently change it.
    const res = await request(app)
      .post('/api/documents')
      .set('Content-Type', 'application/json')
      .send('{"title": broken}');
    expect(res.body.code).toBeUndefined();
  });

  it('serves the generated spec unauthenticated by design', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\.1\./);
  });
});
