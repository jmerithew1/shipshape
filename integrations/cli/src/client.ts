/**
 * Building an authenticated ShipClient from what is on this machine.
 *
 * One function, used by every command that needs a token, so "am I logged
 * in?" is answered in exactly one place and always with the same error.
 */
import { FileTokenStore, ShipClient, ShipError } from '@ship/sdk';
import { credentialsPath, ENV, resolveBaseUrl, resolveClientId, type Env } from './config.js';

export interface GlobalOptions {
  baseUrl?: string | undefined;
  clientId?: string | undefined;
  token?: string | undefined;
}

/**
 * Precedence: `--token` / SHIP_TOKEN beats the stored session. That ordering
 * is what lets CI run the same commands with a provisioned token and no
 * `ship login` step, and it is why the token store is still passed in — a
 * refresh has somewhere to write either way.
 */
export async function authenticatedClient(
  options: GlobalOptions = {},
  env: Env = process.env
): Promise<ShipClient> {
  const baseUrl = resolveBaseUrl(options.baseUrl, env);
  const clientId = resolveClientId(options.clientId, env);
  const tokenStore = new FileTokenStore(credentialsPath());

  const explicitToken = options.token ?? env[ENV.token];
  if (typeof explicitToken === 'string' && explicitToken !== '') {
    return new ShipClient({ baseUrl, clientId, token: explicitToken, tokenStore });
  }

  const stored = await tokenStore.get();
  if (stored === null) {
    throw new ShipError({
      kind: 'auth',
      code: 'not_logged_in',
      message: `No credentials at ${credentialsPath()}`,
      status: 0,
    });
  }

  return new ShipClient({ baseUrl, clientId, tokenStore });
}
