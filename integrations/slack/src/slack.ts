/**
 * Formatting and posting to Slack.
 *
 * WHY `fetch` AND NOT `@slack/web-api`
 * ------------------------------------
 * This integration calls exactly two Slack endpoints — `chat.postMessage` and
 * `oauth.v2.access` — and both are ordinary HTTPS POSTs whose contract is two
 * fields wide (`ok`, `error`). `@slack/web-api` would add a dependency tree
 * (axios, retry, logger, p-queue) to save roughly fifteen lines, and it would
 * hide the one thing this file has to get exactly right: the mapping from a
 * Slack failure to *transient vs. permanent*, which decides whether Ship
 * retries the delivery or dead-letters it. Ship's own SDK is zero-dependency
 * for the same reason. So: global `fetch`, injected for tests.
 *
 * THE SLACK ERROR MODEL IS A TRAP
 * -------------------------------
 * Slack answers `chat.postMessage` with **HTTP 200 and `{ ok: false }`** for
 * most application-level failures. A subscriber that checks `res.ok` alone
 * believes every message was delivered. The status line is checked here, and
 * then the body is checked too.
 */

import {
  asDocumentCreated,
  asIssueAssigned,
  type ShipEventEnvelope,
} from './events.js';

export const SLACK_API_BASE = 'https://slack.com/api';

/** The minimal fetch surface this module needs, so tests can inject a fake. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface SlackMessage {
  channel: string;
  text: string;
}

/**
 * A Slack failure, classified. `permanent` is the load-bearing field: the
 * server turns it into a 4xx (Ship dead-letters) or a 5xx (Ship retries).
 */
export class SlackPostError extends Error {
  readonly permanent: boolean;
  readonly slackError: string | undefined;
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { permanent: boolean; slackError?: string; status?: number }
  ) {
    super(message);
    this.name = 'SlackPostError';
    this.permanent = options.permanent;
    this.slackError = options.slackError;
    this.status = options.status;
  }
}

/**
 * Slack error codes that will never succeed on retry: the token is wrong, the
 * channel does not exist, the app was removed. Retrying these burns Ship's
 * retry ladder to reach the same answer five more times, then dead-letters
 * anyway — so we say "permanent" on the first attempt and let the operator see
 * a dead letter with a real reason in it.
 *
 * Everything NOT on this list is treated as transient. That default is
 * deliberate: a Slack error code this integration has never heard of is more
 * likely a new server-side condition than a new permanent client mistake, and
 * the cost of a wrong "transient" (a few retries) is much lower than the cost
 * of a wrong "permanent" (a message silently dropped forever).
 */
const PERMANENT_SLACK_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission',
  'missing_scope',
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'msg_too_long',
  'no_text',
  'restricted_action',
  'invalid_blocks',
  'team_access_not_granted',
]);

export interface SlackPoster {
  /** Posts, or throws `SlackPostError`. Resolves only on a real Slack `ok:true`. */
  post(message: SlackMessage): Promise<void>;
  /** True when no token/channel is configured and posts are logged instead. */
  readonly dryRun: boolean;
  /** Configured channel id (or the dry-run placeholder). */
  readonly channel: string;
}

export interface SlackPosterOptions {
  token?: string | undefined;
  channel?: string | undefined;
  fetchImpl?: FetchLike;
  logger?: (line: string) => void;
  /** Abort a single Slack HTTP call after this long. */
  timeoutMs?: number;
  apiBase?: string;
}

const DEFAULT_SLACK_TIMEOUT_MS = 5000;

/**
 * Builds the poster. With no `SLACK_BOT_TOKEN`/`SLACK_CHANNEL_ID` it returns a
 * DRY-RUN poster that logs the exact JSON body it would have sent and resolves
 * successfully.
 *
 * That is not a stub for convenience — it is what makes this integration
 * demonstrable end to end (real signed delivery in, real verification, real
 * dedupe, real formatting) on a machine with no Slack workspace attached. The
 * only thing it skips is the HTTP call to Slack.
 */
export function createSlackPoster(options: SlackPosterOptions = {}): SlackPoster {
  const token = options.token?.trim() ?? '';
  const channel = options.channel?.trim() ?? '';
  const log = options.logger ?? ((line: string) => console.log(line));
  const apiBase = options.apiBase ?? SLACK_API_BASE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SLACK_TIMEOUT_MS;

  if (token === '' || channel === '') {
    return {
      dryRun: true,
      channel: channel === '' ? '#dry-run' : channel,
      async post(message: SlackMessage): Promise<void> {
        log(
          `[slack:dry-run] POST ${apiBase}/chat.postMessage ${JSON.stringify({
            channel: message.channel,
            text: message.text,
          })}`
        );
      },
    };
  }

  const doFetch: FetchLike =
    options.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);

  return {
    dryRun: false,
    channel,
    async post(message: SlackMessage): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(`${apiBase}/chat.postMessage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ channel: message.channel, text: message.text }),
          signal: controller.signal,
        });
      } catch (err) {
        // Network failure, DNS, TLS, timeout. Transient by definition: Slack
        // being unreachable says nothing about whether this message is valid.
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        throw new SlackPostError(`Slack unreachable (${detail})`, { permanent: false });
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429) {
        throw new SlackPostError('Slack rate limited (HTTP 429)', {
          permanent: false,
          status: 429,
        });
      }
      if (response.status >= 500) {
        throw new SlackPostError(`Slack server error (HTTP ${response.status})`, {
          permanent: false,
          status: response.status,
        });
      }
      if (response.status >= 400) {
        // A 4xx from Slack's own edge (bad auth header shape, wrong method).
        throw new SlackPostError(`Slack rejected the request (HTTP ${response.status})`, {
          permanent: true,
          status: response.status,
        });
      }

      // HTTP 200 does NOT mean delivered — see the header comment.
      const raw = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new SlackPostError('Slack returned a non-JSON body', {
          permanent: false,
          status: response.status,
        });
      }

      const ok =
        typeof body === 'object' && body !== null && (body as Record<string, unknown>)['ok'] === true;
      if (ok) return;

      const slackError =
        typeof body === 'object' && body !== null
          ? String((body as Record<string, unknown>)['error'] ?? 'unknown_error')
          : 'unknown_error';

      throw new SlackPostError(`Slack refused the message: ${slackError}`, {
        permanent: PERMANENT_SLACK_ERRORS.has(slackError),
        slackError,
        status: response.status,
      });
    },
  };
}

/**
 * Renders an event as Slack text, or returns `null` for an event type this
 * integration does not render.
 *
 * `null` must NOT become a 4xx upstream. Ship dead-letters 4xx, and an operator
 * who subscribed to all eight event types so they could turn one on later would
 * find their subscription quietly filling the dead-letter queue. Filtering
 * locally is the normal subscriber pattern; the honest answer to "I do not care
 * about this event" is 200.
 */
export function formatEvent(event: ShipEventEnvelope): string | null {
  switch (event.type) {
    case 'document.created': {
      const data = asDocumentCreated(event.data);
      if (!data) return null;
      return `📄 New document: *${escapeSlack(data.title)}* (\`${data.document_id}\`)`;
    }
    case 'issue.assigned': {
      const data = asIssueAssigned(event.data);
      if (!data) return null;
      const ticket = data.ticket_number === null ? '(no ticket number)' : `#${data.ticket_number}`;
      const assignee = data.assignee_id === null ? '_unassigned_' : `\`${data.assignee_id}\``;
      return `🎫 ${ticket} *${escapeSlack(data.title)}* assigned to ${assignee}`;
    }
    default:
      return null;
  }
}

/**
 * Slack's minimal escape set for `text`. Titles come from another user's
 * workspace, so a title of `<!channel>` would otherwise ping everyone in the
 * room — a small injection with a loud blast radius.
 */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
