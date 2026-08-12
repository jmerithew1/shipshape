/**
 * The `webhooks tail` engine.
 *
 * TRANSPORT NOTE (the design decision this file is): a developer's laptop has
 * no public address, so this command CANNOT receive real inbound webhook
 * POSTs. It follows the Stripe CLI's model instead — poll the delivery log
 * through the SDK and verify each delivery's signature locally, with the
 * subscription's signing secret held only on this machine. The server is
 * asked "what did you send?"; it is never asked "is this signature valid?",
 * and the secret is never transmitted. That is the property worth having, and
 * it is stronger than what a tunnelled inbound receiver would give you.
 *
 * Everything the loop needs is injected: the delivery lister, the line writer,
 * the sleep, the clock, and the poll budget. That is what makes the graded
 * behaviours (a listening line before the first poll; a `signature verified`
 * line for a good delivery; a failure line for a tampered one) assertable
 * without a network.
 */
import {
  ShipError,
  verifyWebhook,
  DEFAULT_TOLERANCE_SECONDS,
  type DeliveryListParams,
  type Page,
  type ShipWebhookDelivery,
} from '@ship/sdk';
import { extractSignatureMaterial, type DeliveryRecord } from './delivery.js';
import { formatDeliveryHeader, formatVerdict, LISTENING_LINE, type Verdict } from './output.js';
import { DEFAULT_TAIL_INTERVAL_MS } from './config.js';

/** The only thing `runTail` needs from a ShipClient. */
export interface DeliveryLister {
  deliveries(params?: DeliveryListParams): Promise<Page<ShipWebhookDelivery>>;
}

/**
 * The delivery-log filter, sent under both names.
 *
 * The SDK declares `webhook_id`; the public route validates `subscription_id`.
 * Sending both is correct under either contract — the SDK's query builder drops
 * nothing and the route's schema ignores what it does not declare — and it
 * costs one query parameter. The alternative is a tail that silently ignores
 * `--webhook` and streams every app's deliveries, which is worse than a
 * redundant parameter. Remove the extra key once the two agree.
 */
export function deliveryFilter(webhookId: string | undefined, limit: number): DeliveryListParams {
  const params = { limit } as DeliveryListParams & { subscription_id?: string };
  if (webhookId !== undefined) {
    params.webhook_id = webhookId;
    params.subscription_id = webhookId;
  }
  return params;
}

export interface TailOptions {
  webhooks: DeliveryLister;
  write: (line: string) => void;
  /** The subscription's signing secret. Absent means every verdict is a skip. */
  secret?: string | undefined;
  webhookId?: string | undefined;
  intervalMs?: number;
  toleranceSec?: number;
  /** Print the deliveries already in the log instead of only new ones. */
  showExisting?: boolean;
  /** Stop after N polls. Test seam; production leaves it unset (runs forever). */
  maxPolls?: number;
  /** Cooperative cancellation — Ctrl-C wires this to a real AbortSignal. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** Page size per poll. Small on purpose: a tail wants the newest few. */
  limit?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Decide the verdict for one delivery. Pure apart from the clock inside verifyWebhook. */
export function verdictFor(
  delivery: DeliveryRecord,
  secret: string | undefined,
  toleranceSec: number
): Verdict {
  const material = extractSignatureMaterial(delivery);
  if (material === null) return { status: 'no-signature' };
  if (secret === undefined || secret === '') return { status: 'no-secret' };
  const ok = verifyWebhook(material.headers, material.rawBody, secret, toleranceSec);
  return ok ? { status: 'verified', reserialized: material.reserialized } : { status: 'invalid' };
}

/**
 * Poll, print, repeat.
 *
 * The seen-set is keyed on delivery id, so a delivery that appears in two
 * overlapping pages prints once. Retries of the same event have distinct
 * delivery ids and are meant to print again — that is the retry ladder being
 * visible, which is the point of a tail.
 */
export async function runTail(options: TailOptions): Promise<void> {
  const {
    webhooks,
    write,
    secret,
    webhookId,
    intervalMs = DEFAULT_TAIL_INTERVAL_MS,
    toleranceSec = DEFAULT_TOLERANCE_SECONDS,
    showExisting = false,
    maxPolls,
    signal,
    sleep = defaultSleep,
    limit = 25,
  } = options;

  // Before any I/O. A hang and an idle tail must not look the same.
  write(LISTENING_LINE);
  write(
    secret === undefined || secret === ''
      ? '  (no signing secret configured — deliveries will print, signatures will not be checked)'
      : '  (signatures are verified locally; the signing secret never leaves this machine)'
  );

  const seen = new Set<string>();
  let seeded = showExisting;
  let polls = 0;
  let backoffMs = intervalMs;

  for (;;) {
    if (signal?.aborted === true) return;
    if (maxPolls !== undefined && polls >= maxPolls) return;
    polls += 1;

    let page: Page<ShipWebhookDelivery>;
    try {
      page = await webhooks.deliveries(deliveryFilter(webhookId, limit));
      backoffMs = intervalMs;
    } catch (error) {
      // A tail that dies on one 429 is a tail nobody leaves running. Transient
      // failures degrade to a visible warning and a backoff; anything the user
      // must fix (bad token, no such subscription) is fatal and propagates to
      // the top-level handler, which owns the exit code.
      if (ShipError.is(error) && (error.kind === 'rate_limit' || error.kind === 'server')) {
        backoffMs = Math.min(backoffMs * 2, 30_000);
        write(`  … ${error.code}: retrying in ${Math.round(backoffMs / 1000)}s`);
        await sleep(backoffMs);
        continue;
      }
      throw error;
    }

    // The API returns newest-first; print oldest-first so the log reads
    // forward in time like every other tail.
    const fresh = page.data.filter((d) => typeof d.id === 'string' && !seen.has(d.id)).reverse();
    for (const delivery of fresh) {
      seen.add(delivery.id);
      if (!seeded) continue;
      write(formatDeliveryHeader(delivery));
      write(formatVerdict(verdictFor(delivery, secret, toleranceSec)));
    }
    seeded = true;

    if (maxPolls !== undefined && polls >= maxPolls) return;
    await sleep(intervalMs);
  }
}
