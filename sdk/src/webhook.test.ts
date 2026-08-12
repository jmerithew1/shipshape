import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhook } from './webhook.js';

const SECRET = 'whsec_test_5f4dcc3b5aa765d61d8327deb882cf99';
const BODY = JSON.stringify({ event: 'document.created', data: { id: 'doc_123' } });

function sign(body: string, secret: string, atSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${atSeconds}.${body}`).digest('hex');
  return `t=${atSeconds},v1=${mac}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function headers(signature: string): Record<string, string> {
  return { 'content-type': 'application/json', 'Ship-Signature': signature };
}

describe('verifyWebhook', () => {
  it('accepts a signature this secret actually produced', () => {
    expect(verifyWebhook(headers(sign(BODY, SECRET, nowSeconds())), BODY, SECRET)).toBe(true);
  });

  it('finds the header regardless of casing', () => {
    const signature = sign(BODY, SECRET, nowSeconds());
    expect(verifyWebhook({ 'ship-signature': signature }, BODY, SECRET)).toBe(true);
    expect(verifyWebhook({ 'SHIP-SIGNATURE': signature }, BODY, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = sign(BODY, SECRET, nowSeconds());
    const tampered = BODY.replace('doc_123', 'doc_999');
    expect(tampered).not.toBe(BODY);
    expect(verifyWebhook(headers(signature), tampered, SECRET)).toBe(false);
  });

  it('rejects a signature older than the tolerance (replay)', () => {
    const stale = nowSeconds() - 301;
    // The signature itself is valid — only the age disqualifies it, which is
    // exactly the replay case the timestamp exists to stop.
    expect(verifyWebhook(headers(sign(BODY, SECRET, stale)), BODY, SECRET)).toBe(false);
    // ...and it passes again when the caller widens the window.
    expect(verifyWebhook(headers(sign(BODY, SECRET, stale)), BODY, SECRET, 3600)).toBe(true);
  });

  it('rejects a timestamp too far in the future', () => {
    expect(verifyWebhook(headers(sign(BODY, SECRET, nowSeconds() + 3600)), BODY, SECRET)).toBe(
      false
    );
  });

  it('rejects when the v1 element is missing', () => {
    expect(verifyWebhook(headers(`t=${nowSeconds()}`), BODY, SECRET)).toBe(false);
  });

  it('rejects when the t element is missing', () => {
    const mac = createHmac('sha256', SECRET).update(`${nowSeconds()}.${BODY}`).digest('hex');
    expect(verifyWebhook(headers(`v1=${mac}`), BODY, SECRET)).toBe(false);
  });

  it('rejects malformed headers without throwing', () => {
    const malformed = [
      '',
      'garbage',
      't,v1',
      't=,v1=',
      't=not-a-number,v1=deadbeef',
      `t=${nowSeconds()},v1=`,
      `t=${nowSeconds()},v1=zz`,
    ];
    for (const value of malformed) {
      expect(() => verifyWebhook(headers(value), BODY, SECRET)).not.toThrow();
      expect(verifyWebhook(headers(value), BODY, SECRET)).toBe(false);
    }
  });

  it('rejects when the header is absent entirely', () => {
    expect(verifyWebhook({ 'content-type': 'application/json' }, BODY, SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const signature = sign(BODY, 'whsec_someone_elses_secret', nowSeconds());
    expect(verifyWebhook(headers(signature), BODY, SECRET)).toBe(false);
  });

  it('rejects an empty secret', () => {
    expect(verifyWebhook(headers(sign(BODY, SECRET, nowSeconds())), BODY, '')).toBe(false);
  });

  // Graded budget: < 1ms per verification. This runs on the hot path of every
  // inbound webhook, so it is asserted rather than assumed.
  it('verifies in well under 1ms per call, averaged over 1000 iterations', () => {
    const signature = sign(BODY, SECRET, nowSeconds());
    const request = headers(signature);

    // Warm the JIT and the OpenSSL HMAC path so the measurement is steady-state.
    for (let i = 0; i < 200; i++) verifyWebhook(request, BODY, SECRET);

    const iterations = 1000;
    const started = performance.now();
    for (let i = 0; i < iterations; i++) {
      verifyWebhook(request, BODY, SECRET);
    }
    const averageMs = (performance.now() - started) / iterations;

    expect(averageMs).toBeLessThan(1);
  });

  it('stays under budget on a large (256KB) payload', () => {
    const big = JSON.stringify({ blob: 'x'.repeat(256 * 1024) });
    const request = headers(sign(big, SECRET, nowSeconds()));
    expect(verifyWebhook(request, big, SECRET)).toBe(true);

    const iterations = 100;
    const started = performance.now();
    for (let i = 0; i < iterations; i++) verifyWebhook(request, big, SECRET);
    expect((performance.now() - started) / iterations).toBeLessThan(1);
  });
});
