/**
 * `ship webhooks ls | create | tail`
 *
 * `create` is here because of a one-way door in the API: the signing secret is
 * returned exactly once, on the create response, and is never recoverable. A
 * CLI that can subscribe but cannot show you the secret would leave `tail`
 * permanently unable to verify anything.
 */
import type { ShipClient, ShipWebhook } from '@ship/sdk';
import { resolveWebhookSecret } from '../config.js';
import { runTail, type TailOptions } from '../tail.js';

export interface WebhooksDeps {
  write: (line: string) => void;
}

/**
 * The signing secret, under either name.
 *
 * The SDK declares `secret`; the public route returns `signing_secret`. Same
 * mismatch as the delivery fields (see src/delivery.ts) and the same policy:
 * read tolerantly, because the alternative is a CLI that creates a
 * subscription and then cannot tell you the one value you can never get back.
 */
export function signingSecretOf(hook: ShipWebhook): string | undefined {
  const record = hook as ShipWebhook & { signing_secret?: unknown };
  if (typeof hook.secret === 'string' && hook.secret.length > 0) return hook.secret;
  if (typeof record.signing_secret === 'string' && record.signing_secret.length > 0) {
    return record.signing_secret;
  }
  return undefined;
}

/** The event type, under either name. */
export function subscriptionEvent(hook: ShipWebhook): string {
  const record = hook as ShipWebhook & { event_type?: unknown };
  if (typeof hook.event === 'string') return hook.event;
  if (typeof record.event_type === 'string') return record.event_type;
  return 'unknown.event';
}

export async function webhooksList(
  client: Pick<ShipClient, 'webhooks'>,
  deps: WebhooksDeps
): Promise<void> {
  const page = await client.webhooks.list();
  if (page.data.length === 0) {
    deps.write('no webhook subscriptions');
    return;
  }
  for (const hook of page.data) {
    const active = hook.active === false ? ' (inactive)' : '';
    deps.write(`${hook.id}  ${subscriptionEvent(hook).padEnd(20)}  ${hook.target_url}${active}`);
  }
}

export async function webhooksCreate(
  client: Pick<ShipClient, 'webhooks'>,
  options: { event: string; url: string },
  deps: WebhooksDeps
): Promise<void> {
  const hook = await client.webhooks.create({ event: options.event, target_url: options.url });
  deps.write(`subscription ${hook.id}  ${subscriptionEvent(hook)} → ${hook.target_url}`);
  const secret = signingSecretOf(hook);
  if (secret !== undefined) {
    deps.write('');
    deps.write(`signing secret: ${secret}`);
    deps.write('  Store it now — this is the only time it is ever returned.');
    deps.write(`  ship webhooks tail --webhook ${hook.id} --secret ${secret}`);
  } else {
    deps.write('');
    deps.write(
      '  WARNING: the response carried no signing secret, so deliveries for this subscription cannot be verified. Recreate it once the API returns one.'
    );
  }
}

export interface TailCliOptions {
  webhook?: string | undefined;
  secret?: string | undefined;
  interval?: number | undefined;
  tolerance?: number | undefined;
  fromStart?: boolean | undefined;
}

export async function webhooksTail(
  client: Pick<ShipClient, 'webhooks'>,
  options: TailCliOptions,
  deps: WebhooksDeps,
  signal?: AbortSignal
): Promise<void> {
  const tail: TailOptions = {
    webhooks: client.webhooks,
    write: deps.write,
    secret: resolveWebhookSecret(options.secret),
    webhookId: options.webhook,
    showExisting: options.fromStart === true,
  };
  if (options.interval !== undefined) tail.intervalMs = options.interval;
  if (options.tolerance !== undefined) tail.toleranceSec = options.tolerance;
  if (signal !== undefined) tail.signal = signal;
  await runTail(tail);
}
