/**
 * Receiver tests.
 *
 * These run against the REAL Express app on a loopback port, because the two
 * properties worth proving here — that the verified bytes are the received
 * bytes, and that a tampered body never reaches Slack — are properties of the
 * body pipeline. A hand-built `req` object would prove only that the test
 * author remembered to hand over the right string.
 *
 * Slack is always a spy. No test in this file can reach the internet.
 */
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, WEBHOOK_PATH } from './server.js';
import { IdempotencyStore } from './dedupe.js';
import { SlackPostError, type SlackMessage, type SlackPoster } from './slack.js';

const SECRET = 'whsec_test_2f0c6a1b9e';

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * Signs exactly as Ship's deliverer does: HMAC over `${t}.${rawBody}` keyed by
 * the DERIVED key, `sha256(rawSecret)` — the value Ship stores as
 * `signing_secret_hash` and signs with (`api/src/platform/webhooks/deliverer.ts`
 * passes `row.signing_secret_hash` to `signPayload`). The receiver verifies via
 * the SDK's `verifyWebhook`, which derives the same key from the raw secret
 * (`sdk/src/webhook.ts`).
 *
 * This helper keyed the HMAC with the RAW secret until 2026-08-16, which made
 * every positive-path assertion in this file fail with 401 while the negative
 * cases still passed — the failure mode that looks like a broken verifier and is
 * actually a harness that no longer signs like the thing it claims to imitate.
 * It drifted when `914afaf` added the derivation to the SDK without updating the
 * two harnesses that hand-roll a signature.
 */
function sign(rawBody: string, secret = SECRET, atSeconds = Math.floor(Date.now() / 1000)): string {
  const signingKey = createHash('sha256').update(secret, 'utf8').digest('hex');
  const mac = createHmac('sha256', signingKey)
    .update(String(atSeconds))
    .update('.')
    .update(rawBody)
    .digest('hex');
  return `t=${atSeconds},v1=${mac}`;
}

interface SpyPoster extends SlackPoster {
  calls: SlackMessage[];
  /** Queue of outcomes; `undefined`/exhausted means success. */
  outcomes: (Error | undefined)[];
}

function spyPoster(overrides: Partial<Pick<SpyPoster, 'outcomes'>> = {}): SpyPoster {
  const poster: SpyPoster = {
    dryRun: false,
    channel: 'C0TEST',
    calls: [],
    outcomes: overrides.outcomes ?? [],
    async post(message: SlackMessage): Promise<void> {
      poster.calls.push(message);
      const outcome = poster.outcomes.shift();
      if (outcome) throw outcome;
    },
  };
  return poster;
}

const openServers: Server[] = [];

async function listen(app: Express): Promise<string> {
  const server = app.listen(0);
  openServers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

interface DeliverOptions {
  rawBody: string;
  signature?: string;
  idempotencyKey?: string;
  eventType?: string;
  contentType?: string;
}

async function deliver(baseUrl: string, options: DeliverOptions): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': options.contentType ?? 'application/json',
    'Ship-Signature': options.signature ?? sign(options.rawBody),
    'Ship-Idempotency-Key': options.idempotencyKey ?? 'evt_11111111-1111-4111-8111-111111111111',
    'Ship-Event-Id': '11111111-1111-4111-8111-111111111111',
    'Ship-Event-Type': options.eventType ?? 'document.created',
    'Ship-Delivery-Id': '22222222-2222-4222-8222-222222222222',
    'Ship-Delivery-Attempt': '1',
  };
  return fetch(`${baseUrl}${WEBHOOK_PATH}`, {
    method: 'POST',
    headers,
    body: options.rawBody,
  });
}

function documentCreatedBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: '11111111-1111-4111-8111-111111111111',
    type: 'document.created',
    workspace_id: '33333333-3333-4333-8333-333333333333',
    occurred_at: '2026-08-12T10:00:00.000Z',
    data: {
      document_id: '44444444-4444-4444-8444-444444444444',
      document_type: 'spec',
      title: 'Q4 launch plan',
      parent_id: null,
    },
    ...overrides,
  });
}

function issueAssignedBody(): string {
  return JSON.stringify({
    id: '55555555-5555-4555-8555-555555555555',
    type: 'issue.assigned',
    workspace_id: '33333333-3333-4333-8333-333333333333',
    occurred_at: '2026-08-12T10:05:00.000Z',
    data: {
      issue_id: '66666666-6666-4666-8666-666666666666',
      title: 'Signature drift on replay',
      ticket_number: 412,
      assignee_id: '77777777-7777-4777-8777-777777777777',
      previous_assignee_id: null,
    },
  });
}

// ── Happy path ──────────────────────────────────────────────────────────────

describe('valid signed delivery', () => {
  it('posts the expected document.created message and returns 200', async () => {
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const response = await deliver(url, { rawBody: documentCreatedBody() });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'posted' });
    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]!.channel).toBe('C0TEST');
    expect(poster.calls[0]!.text).toContain('📄 New document: *Q4 launch plan*');
    expect(poster.calls[0]!.text).toContain('44444444-4444-4444-8444-444444444444');
  });

  it('posts the expected issue.assigned message with ticket number and assignee', async () => {
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const response = await deliver(url, {
      rawBody: issueAssignedBody(),
      idempotencyKey: 'evt_55555555-5555-4555-8555-555555555555',
      eventType: 'issue.assigned',
    });

    expect(response.status).toBe(200);
    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]!.text).toContain('#412');
    expect(poster.calls[0]!.text).toContain('Signature drift on replay');
    expect(poster.calls[0]!.text).toContain('77777777-7777-4777-8777-777777777777');
  });

  it('verifies the bytes as received, not a re-serialization of them', async () => {
    // Same JSON, different byte layout: whitespace and key order that
    // `JSON.stringify(req.body)` would never reproduce. This delivery is valid
    // and must be accepted — it is the case that fails on a receiver using
    // express.json().
    const rawBody =
      '{\n  "type": "document.created",\n  "id": "11111111-1111-4111-8111-111111111111",\n' +
      '  "workspace_id": "33333333-3333-4333-8333-333333333333",\n' +
      '  "occurred_at": "2026-08-12T10:00:00.000Z",\n' +
      '  "data": { "title": "Spacing matters", "document_id": "44444444-4444-4444-8444-444444444444",' +
      ' "document_type": "spec", "parent_id": null }\n}';

    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const response = await deliver(url, { rawBody });

    expect(response.status).toBe(200);
    expect(poster.calls[0]!.text).toContain('Spacing matters');
  });
});

// ── Signature failures ──────────────────────────────────────────────────────

describe('signature verification', () => {
  it('rejects a tampered body with 401 and never calls Slack', async () => {
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const original = documentCreatedBody();
    const signature = sign(original);
    // One field rewritten after signing — the classic attack, and the one a
    // receiver that verifies the parsed object instead of the bytes waves through.
    const tampered = original.replace('Q4 launch plan', 'Q4 launch plan (edited)');

    const response = await deliver(url, { rawBody: tampered, signature });

    expect(response.status).toBe(401);
    // The security property, not the status code: nothing reached Slack.
    expect(poster.calls).toHaveLength(0);
  });

  it('rejects an expired timestamp with 401 and never calls Slack', async () => {
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, toleranceSec: 300, logger: () => {} });
    const url = await listen(app);

    const rawBody = documentCreatedBody();
    // Correctly signed — for an hour ago. The HMAC covers the timestamp, so an
    // attacker replaying a captured delivery cannot just rewrite `t`.
    const stale = sign(rawBody, SECRET, Math.floor(Date.now() / 1000) - 3600);

    const response = await deliver(url, { rawBody, signature: stale });

    expect(response.status).toBe(401);
    expect(poster.calls).toHaveLength(0);
  });

  it('rejects a signature made with the wrong secret with 401', async () => {
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const rawBody = documentCreatedBody();
    const response = await deliver(url, { rawBody, signature: sign(rawBody, 'whsec_wrong') });

    expect(response.status).toBe(401);
    expect(poster.calls).toHaveLength(0);
  });

  it('rejects a missing signature header with 401', async () => {
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const response = await fetch(`${url}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: documentCreatedBody(),
    });

    expect(response.status).toBe(401);
    expect(poster.calls).toHaveLength(0);
  });

  it('rejects unparseable JSON that is nonetheless correctly signed with 400', async () => {
    // Signed by Ship's secret, so it is not an intruder — it is a permanently
    // broken request. 400 so Ship dead-letters instead of retrying forever.
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const response = await deliver(url, { rawBody: '{"type": "document.created"' });

    expect(response.status).toBe(400);
    expect(poster.calls).toHaveLength(0);
  });
});

// ── Dedupe ──────────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('posts exactly once across two deliveries carrying the same key', async () => {
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const rawBody = documentCreatedBody();
    const key = 'evt_11111111-1111-4111-8111-111111111111';

    const first = await deliver(url, { rawBody, idempotencyKey: key });
    // A replay is re-signed with a fresh timestamp — as Ship's retry path does.
    const second = await deliver(url, { rawBody, idempotencyKey: key, signature: sign(rawBody) });

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'posted' });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: 'duplicate' });
    expect(poster.calls).toHaveLength(1);
  });

  it('CONTROL: the same two deliveries post twice when dedupe is disabled', async () => {
    // Without this the test above is unfalsifiable — it would pass just as well
    // if the harness only ever sent one request, or if the app dropped the
    // second for some unrelated reason. Same inputs, dedupe off, two posts.
    const poster = spyPoster();
    const { app } = createApp({
      secret: SECRET,
      poster,
      store: new IdempotencyStore({ enabled: false }),
      logger: () => {},
    });
    const url = await listen(app);

    const rawBody = documentCreatedBody();
    const key = 'evt_11111111-1111-4111-8111-111111111111';

    await deliver(url, { rawBody, idempotencyKey: key });
    await deliver(url, { rawBody, idempotencyKey: key, signature: sign(rawBody) });

    expect(poster.calls).toHaveLength(2);
  });

  it('does not dedupe two different events', async () => {
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    await deliver(url, { rawBody: documentCreatedBody() });
    await deliver(url, {
      rawBody: issueAssignedBody(),
      idempotencyKey: 'evt_55555555-5555-4555-8555-555555555555',
    });

    expect(poster.calls).toHaveLength(2);
  });

  it('releases the key after a transient failure so Ship\'s retry actually posts', async () => {
    // The failure mode this guards: mark-on-arrival dedupe turns "Slack was
    // briefly down" into "the message is lost forever", because every retry is
    // answered `duplicate`.
    const poster = spyPoster({
      outcomes: [new SlackPostError('Slack unreachable', { permanent: false })],
    });
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const rawBody = documentCreatedBody();
    const key = 'evt_11111111-1111-4111-8111-111111111111';

    const first = await deliver(url, { rawBody, idempotencyKey: key });
    const retry = await deliver(url, { rawBody, idempotencyKey: key, signature: sign(rawBody) });

    expect(first.status).toBe(502);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: 'posted' });
    expect(poster.calls).toHaveLength(2);
  });
});

// ── Event filtering ─────────────────────────────────────────────────────────

describe('unhandled event types', () => {
  it('returns 2xx and posts nothing for sprint.started', async () => {
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const rawBody = JSON.stringify({
      id: '88888888-8888-4888-8888-888888888888',
      type: 'sprint.started',
      workspace_id: '33333333-3333-4333-8333-333333333333',
      occurred_at: '2026-08-12T10:00:00.000Z',
      data: { sprint_id: '99999999-9999-4999-8999-999999999999', title: 'Sprint 12' },
    });

    const response = await deliver(url, { rawBody, eventType: 'sprint.started' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ignored', type: 'sprint.started' });
    expect(poster.calls).toHaveLength(0);
  });

  it('returns 2xx for an event type that does not exist at all', async () => {
    // A 4xx here would dead-letter deliveries for a type Ship might add
    // tomorrow, and the operator would find out from the dead-letter queue.
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const rawBody = JSON.stringify({
      id: '88888888-8888-4888-8888-888888888888',
      type: 'document.archived_v9',
      workspace_id: '33333333-3333-4333-8333-333333333333',
      occurred_at: '2026-08-12T10:00:00.000Z',
      data: {},
    });

    const response = await deliver(url, { rawBody, eventType: 'document.archived_v9' });

    expect(response.status).toBe(200);
    expect(poster.calls).toHaveLength(0);
  });
});

// ── Slack failure classification ────────────────────────────────────────────

describe('Slack failures map onto Ship\'s retry ladder', () => {
  it('returns 5xx when Slack is unreachable, so Ship retries', async () => {
    const poster = spyPoster({
      outcomes: [new SlackPostError('Slack unreachable (FetchError: ECONNREFUSED)', { permanent: false })],
    });
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const response = await deliver(url, { rawBody: documentCreatedBody() });

    expect(response.status).toBe(502);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.json()).toMatchObject({ status: 'retry' });
  });

  it('returns 5xx when Slack rate limits', async () => {
    const poster = spyPoster({
      outcomes: [new SlackPostError('Slack rate limited (HTTP 429)', { permanent: false, status: 429 })],
    });
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const response = await deliver(url, { rawBody: documentCreatedBody() });
    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  it('returns 4xx when Slack permanently rejects, so Ship dead-letters once', async () => {
    const poster = spyPoster({
      outcomes: [
        new SlackPostError('Slack refused the message: channel_not_found', {
          permanent: true,
          slackError: 'channel_not_found',
        }),
      ],
    });
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const response = await deliver(url, { rawBody: documentCreatedBody() });

    expect(response.status).toBe(422);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await response.json()).toMatchObject({ status: 'rejected' });
  });

  it('treats an unclassified error as transient rather than dropping the event', async () => {
    const poster = spyPoster({ outcomes: [new Error('something nobody anticipated')] });
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const response = await deliver(url, { rawBody: documentCreatedBody() });
    expect(response.status).toBe(502);
  });
});

// ── Fast ack ────────────────────────────────────────────────────────────────

describe('ack deadline', () => {
  it('acks 202 rather than holding the connection when Slack is slow', async () => {
    let release: (() => void) | undefined;
    const poster: SpyPoster = {
      dryRun: false,
      channel: 'C0TEST',
      calls: [],
      outcomes: [],
      async post(message: SlackMessage): Promise<void> {
        poster.calls.push(message);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };

    const { app } = createApp({ secret: SECRET, poster, ackDeadlineMs: 20, logger: () => {} });
    const url = await listen(app);

    const response = await deliver(url, { rawBody: documentCreatedBody() });

    expect(response.status).toBe(202);
    expect(poster.calls).toHaveLength(1);
    release?.();
  });

  it('a Ship retry after a 202 does not produce a second Slack message', async () => {
    // The claim is held while the slow post is still in flight, which is the
    // whole reason `claim` happens before the post and not after it.
    let release: (() => void) | undefined;
    const poster: SpyPoster = {
      dryRun: false,
      channel: 'C0TEST',
      calls: [],
      outcomes: [],
      async post(message: SlackMessage): Promise<void> {
        poster.calls.push(message);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };

    const { app } = createApp({ secret: SECRET, poster, ackDeadlineMs: 20, logger: () => {} });
    const url = await listen(app);
    const rawBody = documentCreatedBody();

    const first = await deliver(url, { rawBody });
    const second = await deliver(url, { rawBody, signature: sign(rawBody) });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: 'duplicate' });
    expect(poster.calls).toHaveLength(1);
    release?.();
  });
});

// ── Health ──────────────────────────────────────────────────────────────────

describe('healthz', () => {
  it('reports dry-run state without requiring a signature', async () => {
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);

    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, dryRun: false });
  });
});

// ── Logging hygiene ─────────────────────────────────────────────────────────

describe('logging', () => {
  it('never writes the signing secret to the log', async () => {
    const lines: string[] = [];
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: (line) => lines.push(line) });
    const url = await listen(app);

    await deliver(url, { rawBody: documentCreatedBody(), signature: 't=1,v1=deadbeef' });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

// ── Security review fixes: unsigned dedupe header + the 202 background hole ───
describe('security review — dedupe keys on the signed id, not the header', () => {
  it('ignores a mutated Ship-Idempotency-Key and dedupes on the signed event id', async () => {
    const poster = spyPoster();
    const { app } = createApp({ secret: SECRET, poster, logger: () => {} });
    const url = await listen(app);
    const rawBody = documentCreatedBody();

    // Same signed bytes replayed while the attacker varies the UNSIGNED header.
    // Keying on the header would post twice; keying on the signed event.id
    // makes the second a duplicate.
    const first = await deliver(url, { rawBody, idempotencyKey: 'attacker-1' });
    const second = await deliver(url, {
      rawBody,
      idempotencyKey: 'attacker-2',
      signature: sign(rawBody),
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'posted' });
    expect(await second.json()).toMatchObject({ status: 'duplicate' });
    expect(poster.calls).toHaveLength(1);
  });
});

describe('security review — a post failing after the 202 releases the claim', () => {
  it('releases the held claim when the background post fails after the ack', async () => {
    // Deterministic, no timer race: the post PENDS until we reject it by hand,
    // so the 20ms ack deadline reliably fires first and the request 202s with
    // the post still in flight. We then fail the post and assert the claim was
    // released — previously it stayed held forever and the event was lost, so a
    // Ship redelivery deduped into silence during exactly a Slack incident.
    const poster = spyPoster();
    let rejectPost!: (e: Error) => void;
    const postGate = new Promise<void>((_resolve, reject) => {
      rejectPost = reject;
    });
    poster.post = async (m) => {
      poster.calls.push(m);
      await postGate;
    };

    const store = new IdempotencyStore();
    const { app } = createApp({ secret: SECRET, poster, store, ackDeadlineMs: 20, logger: () => {} });
    const url = await listen(app);
    const rawBody = documentCreatedBody();
    const key = 'evt_11111111-1111-4111-8111-111111111111';

    const res = await deliver(url, { rawBody });
    expect(res.status).toBe(202);
    expect(store.has(key)).toBe(true); // claim held while the post is in flight

    rejectPost(new Error('slack exploded after the ack'));
    await new Promise((r) => setTimeout(r, 30)); // let the background .catch run

    expect(store.has(key)).toBe(false); // released → a redelivery can repost
    expect(poster.calls).toHaveLength(1);
  });
});
