/**
 * Ship-Signature — webhook payload authentication.
 *
 * The construction is Stripe's, deliberately and exactly:
 *
 *     Ship-Signature: t=1770000000,v1=3f8a...c1
 *     signed material = `${t}.${rawBody}`
 *     v1 = HMAC-SHA256(signed material, secret) as lowercase hex
 *
 * Three properties come from that shape, and all three are load-bearing:
 *
 *   - THE TIMESTAMP IS INSIDE THE MAC. Signing `${t}.${body}` rather than the
 *     body alone means an attacker cannot take yesterday's valid signature,
 *     paste today's `t` in front of it, and replay. Change `t` and the MAC
 *     stops matching. A signature over the body alone is replayable forever.
 *   - THE `v1=` TAG VERSIONS THE SCHEME. When the day comes to move to a new
 *     construction, deliveries carry `t=...,v1=...,v2=...` for a migration
 *     window and subscribers upgrade on their own schedule. Without a version
 *     tag, changing the scheme is a flag day for every integration.
 *   - MULTIPLE `v1=` VALUES ARE LEGAL. That is how secret rotation works with
 *     zero downtime: sign with old and new during the overlap; a subscriber
 *     that knows either one verifies.
 *
 * WHAT MUST BE SIGNED IS THE *RAW* BODY. Not the parsed object, not a
 * re-serialization of it. `JSON.parse` then `JSON.stringify` can reorder keys
 * and normalize numbers, and either one silently breaks every signature. The
 * deliverer serializes once and signs and sends the same string; subscribers
 * must capture the raw request body before their JSON middleware touches it.
 *
 * The verifier NEVER throws. A malformed header from an attacker is an
 * ordinary "no" — an exception here would turn signature spoofing into a
 * denial of service against the subscriber's own handler.
 */
import crypto from 'node:crypto';

/** The header the deliverer sets and subscribers read. */
export const SIGNATURE_HEADER = 'Ship-Signature';

/** Companion header carrying the delivery's idempotency key. */
export const IDEMPOTENCY_HEADER = 'Ship-Idempotency-Key';

/** Default replay window, in seconds, in BOTH directions. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureFailureReason =
  | 'missing_header'
  | 'malformed_header'
  | 'missing_timestamp'
  | 'missing_signature'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch';

export type VerificationResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: SignatureFailureReason };

/** Lowercase hex HMAC-SHA256 of `${timestamp}.${rawBody}`. */
export function computeSignature(rawBody: string, secret: string, timestamp: number): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/**
 * Build the full `Ship-Signature` header value.
 *
 * `nowSeconds` is a parameter, not a `Date.now()` call, because the deliverer
 * owns an injected clock and tests advance it by hand — a hidden wall-clock
 * read here would make the signature untestable without sleeping.
 */
export function signPayload(rawBody: string, secret: string, nowSeconds: number): string {
  const t = Math.floor(nowSeconds);
  return `t=${t},v1=${computeSignature(rawBody, secret, t)}`;
}

/**
 * Length-guarded constant-time compare.
 *
 * `timingSafeEqual` THROWS on a length mismatch, so the guard is required for
 * correctness, not just for speed. It leaks only the length of a hex digest,
 * which is a published constant.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

interface ParsedHeader {
  timestamp: number | null;
  signatures: string[];
  malformed: boolean;
}

function parseHeader(header: string): ParsedHeader {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  let sawPair = false;

  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    sawPair = true;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === 't') {
      // Only the first `t` counts. A header with two different timestamps is
      // an attacker probing for a parser that takes the friendlier one.
      if (timestamp === null && /^\d+$/.test(value)) timestamp = Number.parseInt(value, 10);
    } else if (key === 'v1') {
      if (value) signatures.push(value);
    }
    // Unknown schemes (a future v2=) are ignored, not rejected: that is what
    // makes adding one non-breaking for subscribers still on v1.
  }

  return { timestamp, signatures, malformed: !sawPair };
}

/**
 * Verify a `Ship-Signature` header against the raw body.
 *
 * @param toleranceSec Replay window applied in BOTH directions. A far-future
 *   timestamp is just as invalid as an expired one: accepting the future would
 *   let an attacker who captures one delivery hold it for release later, and
 *   would paper over clock skew that ought to be visible.
 * @param nowSeconds Injected clock. Defaults to the wall clock; tests pass it.
 */
export function verifySignature(
  header: string | null | undefined,
  rawBody: string,
  secret: string,
  toleranceSec: number = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): VerificationResult {
  if (!header || typeof header !== 'string' || header.trim() === '') {
    return { ok: false, reason: 'missing_header' };
  }

  const parsed = parseHeader(header);
  if (parsed.malformed) return { ok: false, reason: 'malformed_header' };
  if (parsed.timestamp === null) return { ok: false, reason: 'missing_timestamp' };
  // A header with no `v1=` is a hard reject and never falls through to a MAC
  // comparison. Treating "no signature offered" as anything but a failure is
  // the classic unsigned-token bug.
  if (parsed.signatures.length === 0) return { ok: false, reason: 'missing_signature' };

  const skew = Math.abs(Math.floor(nowSeconds) - parsed.timestamp);
  if (skew > toleranceSec) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const expected = computeSignature(rawBody, secret, parsed.timestamp);
  // Every candidate is compared — no early exit on the first match — so the
  // work done does not depend on which secret verified.
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (constantTimeEquals(candidate, expected)) matched = true;
  }

  return matched ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: 'signature_mismatch' };
}
