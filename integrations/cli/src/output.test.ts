/**
 * Output formatting — including the one property a grep-based check depends
 * on: no failure verdict may contain the pass phrase.
 */
import { describe, expect, it } from 'vitest';
import type { ShipDocument } from '@ship/sdk';
import {
  formatDeliveryHeader,
  formatDocumentDetail,
  formatDocumentRow,
  formatVerdict,
  LISTENING_LINE,
  type Verdict,
} from './output.js';
import { extractSignatureMaterial, payloadText } from './delivery.js';

describe('verdict lines', () => {
  it('says `signature verified` on the pass path', () => {
    expect(formatVerdict({ status: 'verified', reserialized: false })).toContain(
      'signature verified'
    );
  });

  it('flags a re-serialized body so a false negative is explicable', () => {
    expect(formatVerdict({ status: 'verified', reserialized: true })).toContain('re-serialized');
  });

  it.each<Verdict>([{ status: 'invalid' }, { status: 'no-secret' }, { status: 'no-signature' }])(
    'never contains the pass phrase on the %o path',
    (verdict) => {
      expect(formatVerdict(verdict)).not.toContain('signature verified');
    }
  );

  it('names the fix when the secret is missing', () => {
    expect(formatVerdict({ status: 'no-secret' })).toContain('SHIP_WEBHOOK_SECRET');
  });
});

describe('the listening line', () => {
  it('is a non-empty, human-readable sentence', () => {
    expect(LISTENING_LINE).toMatch(/listening for events/);
  });
});

describe('delivery header', () => {
  it('leads with the event type', () => {
    const line = formatDeliveryHeader({
      id: 'del_0123456789abcdef',
      event: 'document.created',
      status: 'succeeded',
      attempt: 2,
      response_status: 200,
    });
    expect(line.startsWith('document.created')).toBe(true);
    expect(line).toContain('attempt 2');
    expect(line).toContain('status succeeded');
    expect(line).toContain('200');
  });

  it('degrades rather than throws on a record missing everything', () => {
    expect(formatDeliveryHeader({})).toContain('unknown.event');
  });

  // The public route returns event_type/attempt_number where the SDK type
  // declares event/attempt. Until those agree, a tail that reads only the
  // SDK's names would print "unknown.event" over every real delivery.
  it('reads the API’s field names as well as the SDK’s', () => {
    const line = formatDeliveryHeader({
      id: 'del_1',
      event_type: 'document.created',
      attempt_number: 3,
      status: 'succeeded',
    });
    expect(line.startsWith('document.created')).toBe(true);
    expect(line).toContain('attempt 3');
  });

  it('prefers the SDK’s names when a record somehow carries both', () => {
    const line = formatDeliveryHeader({
      id: 'del_1',
      event: 'document.created',
      event_type: 'wrong.event',
      attempt: 1,
      attempt_number: 9,
    });
    expect(line).toContain('document.created');
    expect(line).not.toContain('wrong.event');
    expect(line).toContain('attempt 1');
  });
});

describe('document formatting', () => {
  const doc: ShipDocument = {
    id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    title: 'Release checklist',
    document_type: 'wiki',
    created_at: '2026-08-12T09:30:00.000Z',
    updated_at: '2026-08-12T10:00:00.000Z',
  };

  it('puts the title last so titles of any length stay readable', () => {
    const row = formatDocumentRow(doc);
    expect(row.endsWith('Release checklist')).toBe(true);
    expect(row).toContain('2026-08-12');
    expect(row).toContain('wiki');
  });

  it('renders a detail block with aligned labels and no undefined rows', () => {
    const detail = formatDocumentDetail(doc);
    expect(detail).toContain('title');
    expect(detail).toContain('Release checklist');
    expect(detail).not.toContain('undefined');
  });
});

describe('extractSignatureMaterial', () => {
  it('prefers the verbatim raw body over re-serializing the payload', () => {
    const material = extractSignatureMaterial({
      signature: 't=1,v1=abc',
      raw_body: '{"a":1}',
      payload: { a: 1 },
    });
    expect(material?.rawBody).toBe('{"a":1}');
    expect(material?.reserialized).toBe(false);
  });

  it('falls back to the payload and admits it', () => {
    const material = extractSignatureMaterial({ signature: 't=1,v1=abc', payload: { a: 1 } });
    expect(material?.rawBody).toBe('{"a":1}');
    expect(material?.reserialized).toBe(true);
  });

  it('finds the signature in a headers bag at any casing', () => {
    const material = extractSignatureMaterial({
      headers: { 'ship-signature': 't=1,v1=abc' },
      payload: {},
    });
    expect(material?.headers['Ship-Signature']).toBe('t=1,v1=abc');
  });

  it('returns null — never a fake pass — when there is nothing to verify', () => {
    expect(extractSignatureMaterial({ payload: { a: 1 } })).toBeNull();
    expect(extractSignatureMaterial({ signature: 't=1,v1=abc' })).toBeNull();
    expect(extractSignatureMaterial(null)).toBeNull();
    expect(extractSignatureMaterial('not an object')).toBeNull();
  });
});

describe('payloadText', () => {
  it('finds an id whether the record carries raw bytes or a parsed payload', () => {
    expect(payloadText({ raw_body: '{"id":"doc_9"}' })).toContain('doc_9');
    expect(payloadText({ payload: { data: { id: 'doc_9' } } })).toContain('doc_9');
    expect(payloadText({})).toBe('');
  });
});
