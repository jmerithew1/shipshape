/**
 * Ship-Signature tests.
 *
 * Every case here is one of the six the assignment names: valid, tampered
 * body, expired timestamp, far-future timestamp, missing v1, wrong secret.
 * No test sleeps — the verifier takes `nowSeconds`, so "expired" is a number,
 * not a wait.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  computeSignature,
  signPayload,
  verifySignature,
} from './signature.js';

const SECRET = 'ship_whsec_test_secret_value';
const OTHER_SECRET = 'ship_whsec_a_different_secret';
const NOW = 1_770_000_000; // fixed epoch seconds; nothing here reads a clock
const BODY = JSON.stringify({ id: 'evt-1', type: 'issue.created', data: { issue_id: 'i1' } });

describe('signPayload', () => {
  it('produces the t=,v1= header shape', () => {
    const header = signPayload(BODY, SECRET, NOW);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(header.startsWith(`t=${NOW},`)).toBe(true);
  });

  it('signs `${t}.${rawBody}` — the timestamp is inside the MAC', () => {
    const header = signPayload(BODY, SECRET, NOW);
    const v1 = header.split('v1=')[1];
    expect(v1).toBe(computeSignature(BODY, SECRET, NOW));
    // Same body, different timestamp ⇒ different MAC. This is the property
    // that makes captured deliveries un-replayable.
    expect(computeSignature(BODY, SECRET, NOW + 1)).not.toBe(v1);
  });

  it('is deterministic for the same inputs (no hidden clock read)', () => {
    expect(signPayload(BODY, SECRET, NOW)).toBe(signPayload(BODY, SECRET, NOW));
  });

  it('exports the header name so producers and consumers agree', () => {
    expect(SIGNATURE_HEADER).toBe('Ship-Signature');
  });
});

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    const header = signPayload(BODY, SECRET, NOW);
    const result = verifySignature(header, BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW);
    expect(result).toEqual({ ok: true, timestamp: NOW });
  });

  it('accepts a signature anywhere inside the tolerance window', () => {
    const header = signPayload(BODY, SECRET, NOW);
    for (const skew of [-DEFAULT_TOLERANCE_SECONDS, -10, 0, 10, DEFAULT_TOLERANCE_SECONDS]) {
      expect(verifySignature(header, BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW + skew).ok).toBe(
        true
      );
    }
  });

  it('REJECTS a tampered body', () => {
    const header = signPayload(BODY, SECRET, NOW);
    const tampered = BODY.replace('issue.created', 'issue.deleted');
    expect(tampered).not.toBe(BODY);
    const result = verifySignature(header, tampered, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW);
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('REJECTS a single flipped byte in the body', () => {
    const header = signPayload(BODY, SECRET, NOW);
    expect(verifySignature(header, `${BODY} `, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW).ok).toBe(
      false
    );
  });

  it('REJECTS an expired timestamp', () => {
    const header = signPayload(BODY, SECRET, NOW);
    const result = verifySignature(
      header,
      BODY,
      SECRET,
      DEFAULT_TOLERANCE_SECONDS,
      NOW + DEFAULT_TOLERANCE_SECONDS + 1
    );
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('REJECTS a far-future timestamp — tolerance is symmetric', () => {
    // Signed "an hour from now". The MAC is perfectly valid; the clock is not.
    // Accepting the future would let an attacker hold a captured delivery and
    // release it whenever it does the most damage.
    const header = signPayload(BODY, SECRET, NOW + 3600);
    const result = verifySignature(header, BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW);
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('REJECTS a header with no v1= component', () => {
    const result = verifySignature(`t=${NOW}`, BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW);
    expect(result).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('REJECTS a header whose v1= is empty', () => {
    const result = verifySignature(`t=${NOW},v1=`, BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW);
    expect(result).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('REJECTS the wrong secret', () => {
    const header = signPayload(BODY, SECRET, NOW);
    const result = verifySignature(header, BODY, OTHER_SECRET, DEFAULT_TOLERANCE_SECONDS, NOW);
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('REJECTS a missing or blank header without throwing', () => {
    expect(verifySignature(undefined, BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW)).toEqual({
      ok: false,
      reason: 'missing_header',
    });
    expect(verifySignature('   ', BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW)).toEqual({
      ok: false,
      reason: 'missing_header',
    });
  });

  it('REJECTS garbage without throwing — a bad header is a "no", never a crash', () => {
    for (const junk of ['not-a-header', '{}', '=====', 'v1', 't=,v1=']) {
      expect(() => verifySignature(junk, BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW)).not.toThrow();
      expect(verifySignature(junk, BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW).ok).toBe(false);
    }
  });

  it('REJECTS a non-numeric timestamp', () => {
    const header = `t=yesterday,v1=${computeSignature(BODY, SECRET, NOW)}`;
    expect(verifySignature(header, BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW)).toEqual({
      ok: false,
      reason: 'missing_timestamp',
    });
  });

  it('accepts when ONE of several v1= values matches (secret rotation overlap)', () => {
    const good = computeSignature(BODY, SECRET, NOW);
    const stale = computeSignature(BODY, OTHER_SECRET, NOW);
    expect(verifySignature(`t=${NOW},v1=${stale},v1=${good}`, BODY, SECRET, 300, NOW).ok).toBe(true);
    expect(verifySignature(`t=${NOW},v1=${good},v1=${stale}`, BODY, SECRET, 300, NOW).ok).toBe(true);
  });

  it('ignores unknown scheme tags so adding a v2= later is non-breaking', () => {
    const header = `${signPayload(BODY, SECRET, NOW)},v2=deadbeef`;
    expect(verifySignature(header, BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW).ok).toBe(true);
  });

  it('does not accept a truncated signature (length guard, not a crash)', () => {
    const full = computeSignature(BODY, SECRET, NOW);
    const header = `t=${NOW},v1=${full.slice(0, 32)}`;
    expect(verifySignature(header, BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, NOW)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });
});
