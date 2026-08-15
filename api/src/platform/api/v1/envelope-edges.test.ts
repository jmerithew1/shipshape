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

  // Regression: the v1 spec used to be reachable ONLY as raw JSON, and the demo
  // script pointed at /api/docs (the INTERNAL app API) expecting to find the
  // platform routes there. Two different specs — so the platform contract had
  // no rendered documentation at all.
  //
  // Asserting on the BODY, not just the status: every unmatched path falls
  // through to the SPA catch-all, which answers 200 with index.html. A
  // status-only check passes even when the page is completely wrong — which is
  // exactly how this was missed the first time.
  it('renders a docs UI for the v1 platform spec (not the internal API docs)', async () => {
    const res = await request(app).get('/api/v1/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
    expect(res.text).toContain('Ship Platform API v1');
    // Must not be the SPA fallback wearing a 200.
    expect(res.text).not.toContain('<div id="root">');

    // swagger-ui-express emits the config into a separate init script rather
    // than inlining it, so the "which spec does this UI actually load" check
    // belongs there — that is the assertion with teeth.
    const init = await request(app).get('/api/v1/docs/swagger-ui-init.js');
    expect(init.status).toBe(200);
    expect(init.text).toContain('/api/v1/openapi.json');
  });
});
