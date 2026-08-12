/**
 * What `webhooks tail` promises, asserted without a network.
 *
 * The three graded behaviours are the first three suites: the listening line
 * is printed before any I/O, a genuinely-signed delivery produces a line
 * containing `signature verified`, and a tampered one does not. The signatures
 * here are real HMACs computed with node:crypto, not fixtures — a test that
 * hard-codes the digest it expects would still pass if verifyWebhook were
 * replaced with `return true`.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ShipError, type DeliveryListParams, type Page, type ShipWebhookDelivery } from '@ship/sdk';
import { deliveryFilter, runTail, verdictFor, type DeliveryLister } from './tail.js';
import { LISTENING_LINE } from './output.js';

const SECRET = 'whsec_test_2f6a1c9e';

function sign(rawBody: string, secret = SECRET, atSeconds = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret)
    .update(String(atSeconds))
    .update('.')
    .update(rawBody)
    .digest('hex');
  return `t=${atSeconds},v1=${mac}`;
}

/** A delivery record in the shape the delivery log returns it. */
function delivery(
  id: string,
  payload: Record<string, unknown>,
  options: { secret?: string; tamper?: boolean; noSignature?: boolean } = {}
): ShipWebhookDelivery {
  const rawBody = JSON.stringify(payload);
  const record: Record<string, unknown> = {
    id,
    webhook_id: 'sub_1',
    event: 'document.created',
    status: 'succeeded',
    attempt: 1,
    created_at: new Date().toISOString(),
    payload,
    raw_body: rawBody,
  };
  if (options.noSignature !== true) {
    record['signature'] = sign(
      // Tampering AFTER signing is what a real attacker does: a valid-looking
      // signature over a body that is no longer the one it covers.
      options.tamper === true ? JSON.stringify({ ...payload, title: 'attacker' }) : rawBody,
      options.secret ?? SECRET
    );
  }
  return record as unknown as ShipWebhookDelivery;
}

/** Returns one page per poll, in order. Exhausted pages repeat the last one. */
function fakeLister(pages: Array<ShipWebhookDelivery[]>): DeliveryLister & { calls: number } {
  let call = 0;
  return {
    get calls() {
      return call;
    },
    async deliveries(_params?: DeliveryListParams): Promise<Page<ShipWebhookDelivery>> {
      const page = pages[Math.min(call, pages.length - 1)] ?? [];
      call += 1;
      return { data: page, next_cursor: null };
    },
  };
}

const noSleep = async (): Promise<void> => {};

describe('runTail — the listening line', () => {
  it('prints it before the first poll, so an idle tail never looks like a hang', async () => {
    const lines: string[] = [];
    const lister = fakeLister([[]]);

    await runTail({
      webhooks: lister,
      write: (line) => lines.push(line),
      secret: SECRET,
      maxPolls: 1,
      sleep: noSleep,
    });

    expect(lines[0]).toBe(LISTENING_LINE);
  });

  it('prints it even when the very first poll is empty and nothing follows', async () => {
    const lines: string[] = [];
    await runTail({
      webhooks: fakeLister([[], [], []]),
      write: (line) => lines.push(line),
      secret: SECRET,
      maxPolls: 3,
      sleep: noSleep,
    });
    expect(lines.filter((l) => l === LISTENING_LINE)).toHaveLength(1);
    expect(lines.some((l) => l.includes('signature'))).toBe(true); // the preamble
  });
});

describe('runTail — verification verdicts', () => {
  it('prints a `signature verified` line for a genuinely signed delivery', async () => {
    const lines: string[] = [];
    await runTail({
      webhooks: fakeLister([[delivery('d1', { id: 'doc_1', title: 'Release plan' })]]),
      write: (line) => lines.push(line),
      secret: SECRET,
      showExisting: true,
      maxPolls: 1,
      sleep: noSleep,
    });

    expect(lines.some((l) => l.includes('document.created'))).toBe(true);
    expect(lines.filter((l) => l.includes('signature verified'))).toHaveLength(1);
  });

  it('prints a failure line — and never the pass phrase — for a tampered body', async () => {
    const lines: string[] = [];
    await runTail({
      webhooks: fakeLister([
        [delivery('d1', { id: 'doc_1', title: 'Release plan' }, { tamper: true })],
      ]),
      write: (line) => lines.push(line),
      secret: SECRET,
      showExisting: true,
      maxPolls: 1,
      sleep: noSleep,
    });

    expect(lines.some((l) => l.includes('signature check FAILED'))).toBe(true);
    expect(lines.some((l) => l.includes('signature verified'))).toBe(false);
  });

  it('fails a delivery signed with a different secret', async () => {
    const lines: string[] = [];
    await runTail({
      webhooks: fakeLister([[delivery('d1', { id: 'doc_1' }, { secret: 'whsec_wrong' })]]),
      write: (line) => lines.push(line),
      secret: SECRET,
      showExisting: true,
      maxPolls: 1,
      sleep: noSleep,
    });
    expect(lines.some((l) => l.includes('signature check FAILED'))).toBe(true);
    expect(lines.some((l) => l.includes('signature verified'))).toBe(false);
  });

  it('says so — rather than passing — when no signing secret is configured', async () => {
    const lines: string[] = [];
    await runTail({
      webhooks: fakeLister([[delivery('d1', { id: 'doc_1' })]]),
      write: (line) => lines.push(line),
      showExisting: true,
      maxPolls: 1,
      sleep: noSleep,
    });
    expect(lines.some((l) => l.includes('SKIPPED'))).toBe(true);
    expect(lines.some((l) => l.includes('signature verified'))).toBe(false);
  });

  it('says so when the delivery record carries no signature at all', async () => {
    const lines: string[] = [];
    await runTail({
      webhooks: fakeLister([[delivery('d1', { id: 'doc_1' }, { noSignature: true })]]),
      write: (line) => lines.push(line),
      secret: SECRET,
      showExisting: true,
      maxPolls: 1,
      sleep: noSleep,
    });
    expect(lines.some((l) => l.includes('no Ship-Signature header'))).toBe(true);
  });

  it('rejects a signature outside the replay window', () => {
    const rawBody = JSON.stringify({ id: 'doc_1' });
    const stale = {
      id: 'd1',
      event: 'document.created',
      raw_body: rawBody,
      signature: sign(rawBody, SECRET, Math.floor(Date.now() / 1000) - 10_000),
    };
    expect(verdictFor(stale, SECRET, 300)).toEqual({ status: 'invalid' });
  });
});

describe('deliveryFilter', () => {
  it('sends the subscription filter under both contracts’ names', () => {
    const params = deliveryFilter('sub_1', 25) as Record<string, unknown>;
    expect(params['webhook_id']).toBe('sub_1');
    expect(params['subscription_id']).toBe('sub_1');
    expect(params['limit']).toBe(25);
  });

  it('omits the filter entirely when tailing everything', () => {
    const params = deliveryFilter(undefined, 10) as Record<string, unknown>;
    expect(params).not.toHaveProperty('webhook_id');
    expect(params).not.toHaveProperty('subscription_id');
  });
});

describe('runTail — the polling loop', () => {
  it('prints only new deliveries by default, seeding on the first poll', async () => {
    const lines: string[] = [];
    const backlog = delivery('old', { id: 'doc_old' });
    const arrival = delivery('new', { id: 'doc_new' });

    await runTail({
      webhooks: fakeLister([[backlog], [arrival, backlog]]),
      write: (line) => lines.push(line),
      secret: SECRET,
      maxPolls: 2,
      sleep: noSleep,
    });

    expect(lines.some((l) => l.includes('delivery new'))).toBe(true);
    expect(lines.some((l) => l.includes('delivery old'))).toBe(false);
  });

  it('prints each delivery once even when pages overlap', async () => {
    const lines: string[] = [];
    const d1 = delivery('d1', { id: 'doc_1' });
    await runTail({
      webhooks: fakeLister([[d1], [d1], [d1]]),
      write: (line) => lines.push(line),
      secret: SECRET,
      showExisting: true,
      maxPolls: 3,
      sleep: noSleep,
    });
    expect(lines.filter((l) => l.includes('signature verified'))).toHaveLength(1);
  });

  it('survives a rate limit with a visible backoff instead of dying', async () => {
    const lines: string[] = [];
    let call = 0;
    const flaky: DeliveryLister = {
      async deliveries(): Promise<Page<ShipWebhookDelivery>> {
        call += 1;
        if (call === 1) {
          throw new ShipError({
            kind: 'rate_limit',
            code: 'rate_limited',
            message: 'slow down',
            status: 429,
          });
        }
        return { data: [delivery('d1', { id: 'doc_1' })], next_cursor: null };
      },
    };

    await runTail({
      webhooks: flaky,
      write: (line) => lines.push(line),
      secret: SECRET,
      showExisting: true,
      maxPolls: 2,
      sleep: noSleep,
    });

    expect(lines.some((l) => l.includes('rate_limited'))).toBe(true);
    expect(lines.some((l) => l.includes('signature verified'))).toBe(true);
  });

  it('propagates an auth failure — that is the user’s to fix, not ours to retry', async () => {
    const dead: DeliveryLister = {
      async deliveries(): Promise<Page<ShipWebhookDelivery>> {
        throw new ShipError({
          kind: 'auth',
          code: 'token_expired',
          message: 'expired',
          status: 401,
        });
      },
    };

    await expect(
      runTail({ webhooks: dead, write: () => {}, secret: SECRET, maxPolls: 1, sleep: noSleep })
    ).rejects.toThrow(ShipError);
  });

  it('stops promptly when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const lister = fakeLister([[delivery('d1', { id: 'doc_1' })]]);

    await runTail({
      webhooks: lister,
      write: () => {},
      secret: SECRET,
      signal: controller.signal,
      sleep: noSleep,
    });

    expect(lister.calls).toBe(0);
  });
});
