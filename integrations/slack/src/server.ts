/**
 * The webhook receiver.
 *
 * This file is the whole integration in one page: verify, dedupe, format, post,
 * and — the part most subscribers get wrong — answer with a status code that
 * means the right thing to Ship's retry ladder.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STATUS CONTRACT (read this before changing any number below)
 * ─────────────────────────────────────────────────────────────────────────────
 * Ship classifies a delivery response as success / transient / permanent:
 *
 *   2xx → success. Delivery closed, never retried.
 *   4xx → PERMANENT. Dead-lettered immediately, zero retries. (Except 408 and
 *         429, which Ship treats as transient, and 410 which also deactivates
 *         the subscription entirely.)
 *   5xx → transient. Retried on the backoff ladder until it succeeds or the
 *         ladder is exhausted.
 *
 * Getting this backwards is not a cosmetic bug, and it fails in both directions:
 *
 *   • Returning 5xx for a bad signature means Ship retries a request that can
 *     never succeed, every time, forever-ish — the receiver has turned an
 *     attacker's junk POST into sustained load on Ship's delivery workers.
 *   • Returning 4xx because Slack happened to be down means the delivery is
 *     dead-lettered on the first blip. The event is *recoverable* and we threw
 *     it away; a human now has to find it in the dead-letter queue and replay it.
 *
 * So the rule is: **4xx describes THIS REQUEST as unfixable. 5xx describes the
 * world as temporarily broken.** A bad signature is unfixable — the same bytes
 * will fail identically in five minutes. Slack returning 503 is the world.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ACKING FAST
 * ─────────────────────────────────────────────────────────────────────────────
 * Ship aborts a delivery that takes too long and puts it back on the ladder, so
 * a receiver that blocks on a slow downstream manufactures its own retry storm.
 * The Slack post is therefore raced against `ackDeadlineMs` (default 2.5s, well
 * inside Ship's delivery timeout): if Slack answers in time the status reflects
 * the real outcome, and if it does not we return 202 and let the in-flight post
 * finish in the background. The idempotency claim is already held at that point,
 * so a Ship retry of the same event will not produce a second Slack message.
 */

import express, { type Express, type Request, type Response } from 'express';
import { verifyWebhook } from '@ship/sdk';
import { IdempotencyStore } from './dedupe.js';
import { parseEnvelope } from './events.js';
import { formatEvent, SlackPostError, type SlackPoster } from './slack.js';
import { createOAuthRouter, type OAuthRouterDeps } from './oauth.js';

export const WEBHOOK_PATH = '/webhooks/ship';

/** Max accepted body size. Ship's payloads are ids-only and tiny. */
const MAX_BODY_BYTES = 256 * 1024;

/** Default race deadline for the Slack post before we ack with 202. */
export const DEFAULT_ACK_DEADLINE_MS = 2500;

export interface CreateAppOptions {
  /** The subscription's signing secret, shown once by `ship webhooks create`. */
  secret: string;
  poster: SlackPoster;
  store?: IdempotencyStore;
  /** Replay window for the signature, in seconds. SDK default is 300. */
  toleranceSec?: number;
  ackDeadlineMs?: number;
  logger?: (line: string) => void;
  /** Omit to run without the install flow (env-token mode). */
  oauth?: OAuthRouterDeps;
}

export interface AppHandle {
  app: Express;
  store: IdempotencyStore;
}

function headerRecord(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') out[key] = value[0];
  }
  return out;
}

interface RaceResult {
  settled: boolean;
  error?: unknown;
}

/**
 * Resolves when the post settles OR when the deadline fires, whichever is
 * first. A post that loses the race keeps running; its eventual rejection is
 * caught here so it can never surface as an unhandled rejection and take the
 * process down.
 */
async function raceDeadline(work: Promise<void>, deadlineMs: number): Promise<RaceResult> {
  let timer: NodeJS.Timeout | undefined;
  const settled = work.then(
    (): RaceResult => ({ settled: true }),
    (error: unknown): RaceResult => ({ settled: true, error })
  );
  const timeout = new Promise<RaceResult>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), deadlineMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

export function createApp(options: CreateAppOptions): AppHandle {
  const app = express();
  const store = options.store ?? new IdempotencyStore();
  const log = options.logger ?? ((line: string) => console.log(line));
  const ackDeadlineMs = options.ackDeadlineMs ?? DEFAULT_ACK_DEADLINE_MS;

  app.disable('x-powered-by');

  if (options.oauth) app.use(createOAuthRouter(options.oauth));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, dryRun: options.poster.dryRun, deduped: store.size });
  });

  app.post(
    WEBHOOK_PATH,
    // RAW BODY, NOT express.json(). This is the single most common way a
    // subscriber breaks signature verification, and it fails in the most
    // confusing possible way: perfectly valid deliveries return 401.
    //
    // The HMAC covers the exact bytes Ship serialized. `express.json()` parses
    // those bytes into an object and throws the bytes away; `JSON.stringify(
    // req.body)` then re-serializes them and produces a DIFFERENT string —
    // different key order, no original whitespace, different unicode escaping,
    // `1.0` collapsed to `1`. One byte different is a completely different
    // HMAC. So the bytes are held as a Buffer and verified before anything is
    // allowed to parse them.
    express.raw({ type: 'application/json', limit: MAX_BODY_BYTES }),
    (req: Request, res: Response) => {
      void handleDelivery(req, res);
    }
  );

  async function handleDelivery(req: Request, res: Response): Promise<void> {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) {
      // Wrong Content-Type, or some other middleware consumed the body first.
      // Permanent: the same request replayed produces the same non-body.
      res.status(400).json({ error: 'expected a raw application/json body' });
      return;
    }
    const rawBody = body.toString('utf8');

    // ── Gate 1: signature. Before parsing, before any side effect. ───────────
    // 401 (a 4xx) is deliberate: Ship dead-letters it. A signature that does
    // not verify against this secret will not verify on attempt six either, so
    // retrying is pure waste — and if the sender is not Ship at all, retries
    // would be Ship amplifying an attacker's traffic against itself.
    if (!verifyWebhook(headerRecord(req), rawBody, options.secret, options.toleranceSec)) {
      log('[ship] rejected delivery: signature did not verify');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    // ── Gate 2: parse. Only now, on bytes we know Ship signed. ───────────────
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.status(400).json({ error: 'body is not valid JSON' });
      return;
    }

    const event = parseEnvelope(parsed);
    if (!event) {
      res.status(400).json({ error: 'body is not a Ship event envelope' });
      return;
    }

    // ── Gate 3: do we render this type? ─────────────────────────────────────
    // Checked BEFORE claiming an idempotency key, so ignoring an event costs
    // nothing and leaves no state behind. 2xx, not 4xx — see formatEvent's note
    // on why dead-lettering an unrendered event type is the wrong answer.
    const text = formatEvent(event);
    if (text === null) {
      res.status(200).json({ status: 'ignored', type: event.type });
      return;
    }

    // ── Gate 4: dedupe. Delivery is at-least-once; replays reuse the key. ────
    // The key is derived from event.id, which is INSIDE the signed body — never
    // from the Ship-Idempotency-Key header, which the HMAC does not cover.
    // Keying on the header let an attacker who captured one valid signed
    // delivery replay the exact bytes within the 5-minute tolerance while
    // incrementing the header, defeating dedupe and posting N duplicate
    // messages. The signed id cannot be varied without breaking the signature.
    // Found by the security review.
    const idempotencyKey = `evt_${event.id}`;

    if (!store.claim(idempotencyKey)) {
      log(`[ship] duplicate delivery ${idempotencyKey} (${event.type}) — not posting again`);
      res.status(200).json({ status: 'duplicate', key: idempotencyKey });
      return;
    }

    // ── Post, racing the ack deadline. ──────────────────────────────────────
    // The post promise is captured so the 202 background path can OBSERVE it.
    // Previously a post that failed AFTER the 2.5s ack was never seen: the claim
    // stayed held, so Ship's retry (and the operator's manual replay) deduped to
    // a no-op and the message was silently lost — during precisely a Slack
    // incident, when the 2.5–5s band is where failing calls land. Found by the
    // security review.
    const postPromise = options.poster.post({ channel: options.poster.channel, text });
    const result = await raceDeadline(postPromise, ackDeadlineMs);

    if (!result.settled) {
      // Ack now, finish later — but keep watching the post. On success the held
      // claim correctly makes a Ship retry a no-op. On FAILURE we release the
      // claim so the retry/replay actually reposts instead of being deduped into
      // silence. Ship already has its 202 (an accepted delivery), so we cannot
      // change its outcome for THIS attempt — releasing the claim is what makes
      // recovery possible on the next one.
      log(`[ship] ${idempotencyKey}: Slack slow, acking 202 and finishing in background`);
      void postPromise
        .then(() => {
          log(`[ship] ${idempotencyKey}: background post succeeded`);
        })
        .catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          store.release(idempotencyKey);
          log(`[ship] ${idempotencyKey}: background post FAILED after 202 — ${m} (claim released for retry)`);
        });
      res.status(202).json({ status: 'accepted', key: idempotencyKey });
      return;
    }

    if (result.error === undefined) {
      res.status(200).json({ status: 'posted', key: idempotencyKey });
      return;
    }

    const error = result.error;
    const permanent = error instanceof SlackPostError ? error.permanent : false;
    const message = error instanceof Error ? error.message : String(error);

    if (permanent) {
      // Slack will refuse this identically forever (bad token, missing channel,
      // app removed). 422 → Ship dead-letters it once, and the operator gets a
      // dead letter carrying the actual Slack error code instead of six
      // identical failures spread over an hour.
      log(`[ship] ${idempotencyKey}: permanent Slack failure — ${message}`);
      res.status(422).json({ status: 'rejected', error: message });
      return;
    }

    // Transient: Slack unreachable, 5xx, or rate limited. Release the claim so
    // Ship's retry is actually processed rather than deduped into silence, and
    // answer 5xx so Ship retries at all.
    store.release(idempotencyKey);
    log(`[ship] ${idempotencyKey}: transient Slack failure — ${message} (asking Ship to retry)`);
    res.status(502).json({ status: 'retry', error: message });
  }

  return { app, store };
}
