/**
 * Getting the signable bytes back out of a delivery-log record.
 *
 * WHY THIS EXISTS. A developer's laptop is not routable from the internet, so
 * `ship webhooks tail` cannot receive real inbound POSTs. It uses the Stripe
 * CLI's model instead: read the delivery log through the API and verify each
 * delivery's signature LOCALLY. The property that makes this worth doing is
 * that the signing secret never leaves the client — the server is asked only
 * "what did you send?", never "was this signature good?".
 *
 * For that to work the delivery record has to carry two things: the exact
 * bytes that were signed, and the `Ship-Signature` header that was sent with
 * them. The SDK's `ShipWebhookDelivery` type does not declare either (the
 * webhook routes are landing in a parallel change), so this module reads them
 * defensively off the record and reports honestly when they are absent —
 * rather than pretending a delivery verified when there was nothing to check.
 *
 * The `raw_body`/`signed_body` field is preferred over re-serializing
 * `payload`: an HMAC is over bytes, and `JSON.stringify` of a JSONB column
 * will not reproduce the original key order or whitespace in general. Where
 * only `payload` is available the re-serialized form is used and the verdict
 * says so, because a false negative that is explained is recoverable and a
 * silent one is not.
 */
import { SHIP_SIGNATURE_HEADER, type ShipWebhookDelivery } from '@ship/sdk';

/**
 * The fields a delivery record may carry beyond the SDK's declared type.
 * Every one is optional — this is a read of an evolving wire shape, not a
 * claim about it.
 */
export interface DeliveryRecord extends Partial<ShipWebhookDelivery> {
  payload?: unknown;
  raw_body?: unknown;
  signed_body?: unknown;
  signature?: unknown;
  signature_header?: unknown;
  headers?: unknown;
}

export interface SignatureMaterial {
  /** Headers in the shape `verifyWebhook` expects. */
  headers: Record<string, string>;
  /** The bytes to HMAC. */
  rawBody: string;
  /** True when `rawBody` was re-serialized from `payload` rather than sent verbatim. */
  reserialized: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** Pull `Ship-Signature` out of a headers bag at any casing. */
function signatureFromHeaderBag(bag: unknown): string | undefined {
  const headers = asRecord(bag);
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SHIP_SIGNATURE_HEADER.toLowerCase() && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/**
 * Returns the material to verify, or `null` when the record does not carry a
 * signature or a body. `null` is a verdict ("cannot be checked"), not an
 * error — the caller prints it and keeps tailing.
 */
export function extractSignatureMaterial(delivery: unknown): SignatureMaterial | null {
  const record = asRecord(delivery) as DeliveryRecord | undefined;
  if (!record) return null;

  const signature = firstString(
    record.signature,
    record.signature_header,
    signatureFromHeaderBag(record.headers)
  );
  if (signature === undefined) return null;

  const verbatim = firstString(record.raw_body, record.signed_body);
  if (verbatim !== undefined) {
    return {
      headers: { [SHIP_SIGNATURE_HEADER]: signature },
      rawBody: verbatim,
      reserialized: false,
    };
  }

  if (record.payload === undefined || record.payload === null) return null;
  return {
    headers: { [SHIP_SIGNATURE_HEADER]: signature },
    rawBody: JSON.stringify(record.payload),
    reserialized: true,
  };
}

/** Flatten a delivery's payload to a searchable string, for "is this mine?". */
export function payloadText(delivery: unknown): string {
  const record = asRecord(delivery) as DeliveryRecord | undefined;
  if (!record) return '';
  const verbatim = firstString(record.raw_body, record.signed_body);
  if (verbatim !== undefined) return verbatim;
  if (record.payload === undefined) return '';
  try {
    return JSON.stringify(record.payload);
  } catch {
    return '';
  }
}
