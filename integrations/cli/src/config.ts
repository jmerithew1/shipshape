/**
 * Where the CLI gets its ambient configuration.
 *
 * Precedence is the same everywhere and is the only thing this module exists
 * to make true: explicit flag > environment variable > built-in default. No
 * command reads `process.env` directly, so "why did it talk to the wrong
 * server?" has exactly one place to look.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The deployed grader instance. Defaulting to it (rather than to the SDK's
 * localhost) is deliberate: `npx ship docs ls` should do something useful on a
 * laptop that has never run the API, which is the whole point of a CLI as the
 * first-run surface. `--base-url` / SHIP_BASE_URL override it.
 */
export const DEFAULT_BASE_URL = 'https://ship-api-r1om.onrender.com';

/** The registered public client for the CLI (device grant, no secret). */
export const DEFAULT_CLIENT_ID = 'ship_app_e46d52564bc1f690';

/** Poll cadence for `webhooks tail`, in milliseconds. */
export const DEFAULT_TAIL_INTERVAL_MS = 1000;

/** Environment variable names, named once so tests and help text agree. */
export const ENV = {
  baseUrl: 'SHIP_BASE_URL',
  clientId: 'SHIP_CLIENT_ID',
  clientSecret: 'SHIP_CLIENT_SECRET',
  token: 'SHIP_TOKEN',
  webhookSecret: 'SHIP_WEBHOOK_SECRET',
} as const;

export type Env = Record<string, string | undefined>;

function pick(explicit: string | undefined, envKey: string, fallback: string, env: Env): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  const fromEnv = env[envKey];
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  return fallback;
}

export function resolveBaseUrl(explicit?: string, env: Env = process.env): string {
  return pick(explicit, ENV.baseUrl, DEFAULT_BASE_URL, env);
}

export function resolveClientId(explicit?: string, env: Env = process.env): string {
  return pick(explicit, ENV.clientId, DEFAULT_CLIENT_ID, env);
}

export function resolveWebhookSecret(explicit?: string, env: Env = process.env): string | undefined {
  if (explicit !== undefined && explicit !== '') return explicit;
  const fromEnv = env[ENV.webhookSecret];
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined;
}

/**
 * `~/.ship/credentials.json` — 0600, written by FileTokenStore.
 *
 * A dotted directory under $HOME rather than an XDG path because that is where
 * every CLI a developer already trusts (gh, aws, docker) puts its credentials,
 * and matching the convention is worth more than matching the spec.
 */
export function credentialsPath(home: string = homedir()): string {
  return join(home, '.ship', 'credentials.json');
}
