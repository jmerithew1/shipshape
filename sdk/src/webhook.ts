/**
 * Webhook signature verification.
 *
 * Header format (Stripe-style):
 *     Ship-Signature: t=<unix-seconds>,v1=<hex hmac-sha256>
 *
 * The HMAC covers `${t}.${rawBody}`, not the body alone. Binding the
 * timestamp into the signed material is what makes the timestamp itself
 * unforgeable — otherwise an attacker replaying a captured payload could
 * simply rewrite `t` to now and the signature would still check out.
 *
 * Two properties are load-bearing and worth stating explicitly:
 *
 *  1. **Constant time.** The comparison is `crypto.timingSafeEqual`, never
 *     `===`. A short-circuiting string compare leaks how many leading hex
 *     characters were right, which is enough to forge a signature byte by
 *     byte over enough requests.
 *
 *  2. **Synchronous and allocation-light.** This runs on the hot path of
 *     every inbound webhook and is held to <1ms per call (graded budget, and
 *     asserted by a 1000-iteration loop in webhook.test.ts). Hence: no async,
 *     no regex over the body, no building of the `${t}.${rawBody}` string —
 *     the digest is fed in three `update()` chunks instead, so a 1MB payload
 *     is never copied.
 *
 * `rawBody` must be the exact bytes received. Verifying `JSON.stringify(req.body)`
 * cannot work: key order and whitespace will not survive the round trip.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SHIP_SIGNATURE_HEADER = 'Ship-Signature';

/** Default replay window, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

function pickSignatureHeader(headers: Record<string, string>): string | undefined {
  // Fast path: the two casings that actually occur (Node lowercases inbound
  // headers; hand-built objects use the canonical form).
  const canonical = headers[SHIP_SIGNATURE_HEADER];
  if (typeof canonical === 'string') return canonical;
  const lower = headers['ship-signature'];
  if (typeof lower === 'string') return lower;

  // Slow path, only for oddly-cased inputs.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'ship-signature') {
      const value = headers[key];
      return typeof value === 'string' ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Returns true only when the signature is present, well-formed, correct for
 * this exact body and secret, and inside the replay window. Never throws —
 * a malformed header is an untrusted input, not an exception.
 */
export function verifyWebhook(
  headers: Record<string, string>,
  rawBody: string,
  secret: string,
  toleranceSec: number = DEFAULT_TOLERANCE_SECONDS
): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof rawBody !== 'string') return false;

  const header = pickSignatureHeader(headers);
  if (header === undefined || header.length === 0) return false;

  let timestamp = '';
  let signature = '';

  const elements = header.split(',');
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (element === undefined) continue;
    const eq = element.indexOf('=');
    if (eq === -1) continue;
    const key = element.slice(0, eq).trim();
    if (key === 't') {
      if (timestamp === '') timestamp = element.slice(eq + 1).trim();
    } else if (key === 'v1') {
      // First v1 wins; a second one is an attacker appending a candidate.
      if (signature === '') signature = element.slice(eq + 1).trim();
    }
  }

  // A missing `v1=` element is a hard reject — never a pass-through.
  if (timestamp === '' || signature === '') return false;

  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt)) return false;

  const skew = Math.abs(Math.floor(Date.now() / 1000) - issuedAt);
  if (skew > toleranceSec) return false;

  // Ship signs deliveries with the DERIVED key — sha256(rawSecret), the value
  // it stores as signing_secret_hash — NOT the raw secret it showed you once.
  // So the verifier must derive the same key first; HMAC-ing with the raw
  // secret never matches a real Ship delivery. (The server's signing note says
  // "the SDK's one-call verifier does this for them" — this is that step.)
  const signingKey = createHash('sha256').update(secret, 'utf8').digest('hex');
  const expected = createHmac('sha256', signingKey)
    .update(timestamp)
    .update('.')
    .update(rawBody)
    .digest('hex');

  // timingSafeEqual throws on a length mismatch, so the length check has to
  // come first. Length is not secret: it is fixed at 64 hex chars by SHA-256.
  if (signature.length !== expected.length) return false;

  const provided = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  if (provided.length !== computed.length) return false;

  return timingSafeEqual(provided, computed);
}
