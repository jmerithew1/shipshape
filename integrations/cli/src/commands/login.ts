/**
 * `ship login` — RFC 8628 Device Grant.
 *
 * The device grant is the right flow here for a reason worth stating: a CLI is
 * a public client with no place to keep a secret and, on a server or in a
 * container, no browser to redirect. Device grant moves the human step to
 * whatever machine does have a browser and leaves the CLI holding only a
 * device code.
 *
 * The command ends by calling `me()` and printing the email. That is not
 * cosmetic — "the token endpoint returned 200" and "I have a working session"
 * are different claims, and only the second one is worth telling a user.
 */
import { FileTokenStore, ShipClient } from '@ship/sdk';
import { credentialsPath, resolveBaseUrl, resolveClientId } from '../config.js';
import type { GlobalOptions } from '../client.js';

export interface LoginDeps {
  write: (line: string) => void;
  /** Injected so a test never opens a socket. */
  deviceLogin?: typeof ShipClient.deviceLogin;
}

/**
 * The device authorization response may carry a relative `verification_uri`
 * (`/device?user_code=…`), which is legal but unusable: a relative path is not
 * something a user can paste into a browser on another machine, which is the
 * entire premise of the device grant. Resolve it against the API origin so the
 * line we print is always a real, clickable URL.
 */
export function absoluteVerifyUrl(verifyUrl: string, baseUrl: string): string {
  try {
    return new URL(verifyUrl, `${baseUrl.replace(/\/+$/, '')}/`).toString();
  } catch {
    return verifyUrl;
  }
}

export async function loginCommand(
  options: GlobalOptions & { scope?: string | undefined },
  deps: LoginDeps
): Promise<void> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const clientId = resolveClientId(options.clientId);
  const path = credentialsPath();
  const tokenStore = new FileTokenStore(path);
  const deviceLogin = deps.deviceLogin ?? ShipClient.deviceLogin.bind(ShipClient);

  const client = await deviceLogin({
    baseUrl,
    clientId,
    tokenStore,
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    onUserCode: (code, verifyUrl) => {
      deps.write('');
      deps.write(`  Open:      ${absoluteVerifyUrl(verifyUrl, baseUrl)}`);
      deps.write(`  Enter code: ${code}`);
      deps.write('');
      deps.write('  Waiting for approval…');
    },
  });

  // Prove the token before claiming success.
  const me = await client.me();
  deps.write(`Logged in as ${me.email}`);
  deps.write(`  credentials: ${path} (0600)`);
}
