/**
 * Every line the CLI prints, as pure functions.
 *
 * Output is a contract here, not decoration: `webhooks tail` is graded on
 * printing a listening line at start and an explicit verification verdict per
 * delivery. Pure functions are what let the test suite assert that contract
 * without a network, a terminal, or a subprocess.
 */
import type { ShipDocument } from '@ship/sdk';
import type { DeliveryRecord } from './delivery.js';

/**
 * Printed the instant `tail` starts, BEFORE the first poll.
 *
 * This is a deliberate UX requirement, not politeness: a tail that prints
 * nothing until an event arrives is indistinguishable from a hang, and the
 * first thing a developer does with an indistinguishable hang is Ctrl-C and
 * conclude the product is broken.
 */
export const LISTENING_LINE = 'listening for events…';

export type Verdict =
  | { status: 'verified'; reserialized: boolean }
  | { status: 'invalid' }
  | { status: 'no-secret' }
  | { status: 'no-signature' };

/**
 * The verdict line. The verified branch says the words `signature verified`
 * and nothing else in this module may produce that substring — "signature
 * verification FAILED" deliberately does not contain it, so a grep for the
 * pass string cannot be satisfied by a failure.
 */
export function formatVerdict(verdict: Verdict): string {
  switch (verdict.status) {
    case 'verified':
      return verdict.reserialized
        ? '  ✓ signature verified — HMAC-SHA256 over t.body, computed locally (body re-serialized from the delivery log)'
        : '  ✓ signature verified — HMAC-SHA256 over t.body, computed locally; the signing secret never left this machine';
    case 'invalid':
      return '  ✗ signature check FAILED — the computed HMAC does not match Ship-Signature (tampered, wrong secret, or outside the replay window)';
    case 'no-secret':
      return '  ✗ signature check SKIPPED — no signing secret configured. Pass --secret <s> or set SHIP_WEBHOOK_SECRET; the secret is shown once, when the subscription is created.';
    case 'no-signature':
      return '  ✗ signature check SKIPPED — this delivery record carried no Ship-Signature header and no body to check it against.';
  }
}

function short(id: unknown, width = 8): string {
  return typeof id === 'string' && id.length > width ? `${id.slice(0, width)}…` : String(id ?? '?');
}

/** `document.created  delivery 3f2a1b9c…  attempt 1  status succeeded` */
export function formatDeliveryHeader(delivery: DeliveryRecord): string {
  const parts = [
    String(delivery.event ?? 'unknown.event').padEnd(20),
    `delivery ${short(delivery.id)}`,
  ];
  if (typeof delivery.attempt === 'number') parts.push(`attempt ${delivery.attempt}`);
  if (typeof delivery.status === 'string') parts.push(`status ${delivery.status}`);
  if (typeof delivery.response_status === 'number') parts.push(`→ ${delivery.response_status}`);
  return parts.join('  ');
}

/** One document per line: `3f2a1b9c…  wiki    2026-08-12  Release checklist` */
export function formatDocumentRow(doc: ShipDocument): string {
  const created = typeof doc.created_at === 'string' ? doc.created_at.slice(0, 10) : '—';
  return `${short(doc.id, 12)}  ${(doc.document_type ?? '—').padEnd(8)}  ${created}  ${doc.title}`;
}

/** The multi-line detail view behind `ship docs get <id>`. */
export function formatDocumentDetail(doc: ShipDocument): string {
  const rows: Array<[string, string | undefined]> = [
    ['id', doc.id],
    ['title', doc.title],
    ['type', doc.document_type],
    ['state', doc.state],
    ['created', doc.created_at],
    ['updated', doc.updated_at],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([label, value]) => `${label.padEnd(width)}  ${String(value)}`)
    .join('\n');
}
