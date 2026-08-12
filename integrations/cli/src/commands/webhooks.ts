/**
 * `ship webhooks ls | create | tail`
 *
 * `create` is here because of a one-way door in the API: the signing secret is
 * returned exactly once, on the create response, and is never recoverable. A
 * CLI that can subscribe but cannot show you the secret would leave `tail`
 * permanently unable to verify anything.
 */
import type { ShipClient } from '@ship/sdk';
import { resolveWebhookSecret } from '../config.js';
import { runTail, type TailOptions } from '../tail.js';

export interface WebhooksDeps {
  write: (line: string) => void;
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
    deps.write(`${hook.id}  ${hook.event.padEnd(20)}  ${hook.target_url}${active}`);
  }
}

export async function webhooksCreate(
  client: Pick<ShipClient, 'webhooks'>,
  options: { event: string; url: string },
  deps: WebhooksDeps
): Promise<void> {
  const hook = await client.webhooks.create({ event: options.event, target_url: options.url });
  deps.write(`subscription ${hook.id}  ${hook.event} → ${hook.target_url}`);
  if (typeof hook.secret === 'string' && hook.secret.length > 0) {
    deps.write('');
    deps.write(`signing secret: ${hook.secret}`);
    deps.write('  Store it now — this is the only time it is ever returned.');
    deps.write(`  ship webhooks tail --webhook ${hook.id} --secret ${hook.secret}`);
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
