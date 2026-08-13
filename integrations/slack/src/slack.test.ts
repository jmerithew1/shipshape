import { describe, expect, it } from 'vitest';
import {
  createSlackPoster,
  formatEvent,
  SlackPostError,
  type FetchLike,
  type SlackMessage,
} from './slack.js';
import type { ShipEventEnvelope } from './events.js';

function envelope(type: string, data: unknown): ShipEventEnvelope {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type,
    workspace_id: '33333333-3333-4333-8333-333333333333',
    occurred_at: '2026-08-12T10:00:00.000Z',
    data,
  };
}

interface FakeCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function fakeFetch(
  responses: { status: number; body: string }[],
  calls: FakeCall[] = []
): { fetchImpl: FetchLike; calls: FakeCall[] } {
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input, body: init?.body ?? '', headers: init?.headers ?? {} });
    const next = responses.shift() ?? { status: 200, body: JSON.stringify({ ok: true }) };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body,
    };
  };
  return { fetchImpl, calls };
}

// ── Formatting ──────────────────────────────────────────────────────────────

describe('formatEvent', () => {
  it('renders document.created with the title and the document id', () => {
    const text = formatEvent(
      envelope('document.created', {
        document_id: '44444444-4444-4444-8444-444444444444',
        document_type: 'spec',
        title: 'Q4 launch plan',
        parent_id: null,
      })
    );
    expect(text).toBe('📄 New document: *Q4 launch plan* (`44444444-4444-4444-8444-444444444444`)');
  });

  it('renders issue.assigned with ticket number and assignee id', () => {
    const text = formatEvent(
      envelope('issue.assigned', {
        issue_id: '66666666-6666-4666-8666-666666666666',
        title: 'Signature drift on replay',
        ticket_number: 412,
        assignee_id: '77777777-7777-4777-8777-777777777777',
        previous_assignee_id: null,
      })
    );
    expect(text).toBe(
      '🎫 #412 *Signature drift on replay* assigned to `77777777-7777-4777-8777-777777777777`'
    );
  });

  it('handles a null ticket number and a null assignee without printing "null"', () => {
    const text = formatEvent(
      envelope('issue.assigned', {
        issue_id: '66666666-6666-4666-8666-666666666666',
        title: 'Unfiled',
        ticket_number: null,
        assignee_id: null,
        previous_assignee_id: null,
      })
    );
    expect(text).toContain('(no ticket number)');
    expect(text).toContain('_unassigned_');
    expect(text).not.toContain('null');
  });

  it('escapes a title that would otherwise ping the channel', () => {
    // Titles come from a user in someone else's workspace. `<!channel>` in a
    // Slack `text` field notifies everyone in the room.
    const text = formatEvent(
      envelope('document.created', {
        document_id: '44444444-4444-4444-8444-444444444444',
        document_type: 'spec',
        title: '<!channel> free lunch',
        parent_id: null,
      })
    );
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).not.toContain('<!channel>');
  });

  it('returns null for an event type it does not render', () => {
    expect(formatEvent(envelope('sprint.started', { sprint_id: 'x', title: 'S12' }))).toBeNull();
  });

  it('returns null rather than throwing when the payload is the wrong shape', () => {
    // A malformed payload is not a crash; it is a delivery we cannot render.
    expect(formatEvent(envelope('document.created', { nope: true }))).toBeNull();
    expect(formatEvent(envelope('issue.assigned', null))).toBeNull();
  });
});

// ── Dry run ─────────────────────────────────────────────────────────────────

describe('dry-run poster', () => {
  it('logs the exact payload it would have posted and never calls fetch', async () => {
    const lines: string[] = [];
    const { fetchImpl, calls } = fakeFetch([]);
    const poster = createSlackPoster({
      token: '',
      channel: '',
      fetchImpl,
      logger: (line) => lines.push(line),
    });

    expect(poster.dryRun).toBe(true);
    await poster.post({ channel: '#dry-run', text: '📄 New document: *Hello*' });

    expect(calls).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!).toContain('chat.postMessage');
    expect(lines[0]!).toContain('📄 New document: *Hello*');
  });

  it('falls back to dry run when only the channel is missing', async () => {
    const poster = createSlackPoster({ token: 'xoxb-real', channel: '', logger: () => {} });
    expect(poster.dryRun).toBe(true);
  });
});

// ── Live poster ─────────────────────────────────────────────────────────────

describe('live poster', () => {
  const message: SlackMessage = { channel: 'C0TEST', text: 'hello' };

  it('posts to chat.postMessage with a bearer token and JSON body', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: JSON.stringify({ ok: true }) }]);
    const poster = createSlackPoster({ token: 'xoxb-abc', channel: 'C0TEST', fetchImpl });

    await poster.post(message);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0]!.headers['Authorization']).toBe('Bearer xoxb-abc');
    expect(JSON.parse(calls[0]!.body)).toEqual({ channel: 'C0TEST', text: 'hello' });
  });

  it('treats HTTP 200 with ok:false as a failure, not a success', async () => {
    // The Slack trap: the transport succeeded, the message did not.
    const { fetchImpl } = fakeFetch([
      { status: 200, body: JSON.stringify({ ok: false, error: 'channel_not_found' }) },
    ]);
    const poster = createSlackPoster({ token: 'xoxb-abc', channel: 'C0TEST', fetchImpl });

    await expect(poster.post(message)).rejects.toThrow(SlackPostError);
  });

  it('classifies invalid_auth and channel_not_found as permanent', async () => {
    for (const slackError of ['invalid_auth', 'channel_not_found', 'not_in_channel']) {
      const { fetchImpl } = fakeFetch([
        { status: 200, body: JSON.stringify({ ok: false, error: slackError }) },
      ]);
      const poster = createSlackPoster({ token: 'xoxb-abc', channel: 'C0TEST', fetchImpl });
      await poster.post(message).then(
        () => expect.unreachable(`expected ${slackError} to throw`),
        (err: unknown) => {
          expect(err).toBeInstanceOf(SlackPostError);
          expect((err as SlackPostError).permanent).toBe(true);
          expect((err as SlackPostError).slackError).toBe(slackError);
        }
      );
    }
  });

  it('classifies ratelimited and a 5xx as transient', async () => {
    const cases: { status: number; body: string }[] = [
      { status: 200, body: JSON.stringify({ ok: false, error: 'ratelimited' }) },
      { status: 503, body: 'service unavailable' },
      { status: 429, body: 'slow down' },
    ];
    for (const response of cases) {
      const { fetchImpl } = fakeFetch([response]);
      const poster = createSlackPoster({ token: 'xoxb-abc', channel: 'C0TEST', fetchImpl });
      await poster.post(message).then(
        () => expect.unreachable('expected a throw'),
        (err: unknown) => expect((err as SlackPostError).permanent).toBe(false)
      );
    }
  });

  it('classifies a network failure as transient', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const poster = createSlackPoster({ token: 'xoxb-abc', channel: 'C0TEST', fetchImpl });

    await poster.post(message).then(
      () => expect.unreachable('expected a throw'),
      (err: unknown) => {
        expect((err as SlackPostError).permanent).toBe(false);
        expect((err as Error).message).toContain('unreachable');
      }
    );
  });

  it('defaults an unknown Slack error code to transient', async () => {
    // Better a few wasted retries than a message dropped because Slack shipped
    // an error code this integration has not heard of yet.
    const { fetchImpl } = fakeFetch([
      { status: 200, body: JSON.stringify({ ok: false, error: 'some_brand_new_error' }) },
    ]);
    const poster = createSlackPoster({ token: 'xoxb-abc', channel: 'C0TEST', fetchImpl });

    await poster.post(message).then(
      () => expect.unreachable('expected a throw'),
      (err: unknown) => expect((err as SlackPostError).permanent).toBe(false)
    );
  });
});
