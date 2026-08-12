/**
 * ShipClient — the composition root of the SDK.
 *
 * Everything a consumer needs hangs off one object: four resource clients,
 * `me()`, and the three OAuth grants as static factories. The factories are
 * static because they *produce* an authenticated client; you cannot call them
 * on an instance that does not exist yet.
 *
 * The constructor takes the token *or* a token store, never a "log me in"
 * side effect — construction stays synchronous and free of I/O, which is what
 * lets a test build a client without a network at all.
 */
import { HttpClient, normalizeBaseUrl } from './http.js';
import { SDK_ROUTES } from './manifest.js';
import {
  runAuthorizationCodeFlow,
  runClientCredentials,
  runDeviceFlow,
  type AuthorizationCodeFlowOptions,
} from './oauth.js';
import { DocumentsClient, IssuesClient, SprintsClient, WebhooksClient } from './resources.js';
import { MemoryTokenStore, type ITokenStore } from './token-store.js';
import type { ShipUser } from './types.js';
import { ShipError } from './errors.js';

export const DEFAULT_BASE_URL = 'http://localhost:3000';

export interface ShipClientOptions {
  /** A raw access token. Convenient for scripts and for grader credentials. */
  token?: string;
  /** Origin of the Ship API. `/api/v1` is appended by the client. */
  baseUrl?: string;
  /** Where tokens live. Defaults to in-memory, seeded with `token`. */
  tokenStore?: ITokenStore;
  /** Inject a fetch implementation — the seam every test in this package uses. */
  fetch?: typeof fetch;
  /** Needed only if this client should be able to refresh its own tokens. */
  clientId?: string;
  clientSecret?: string;
}

export interface DeviceLoginOptions {
  baseUrl: string;
  clientId: string;
  onUserCode: (code: string, verifyUrl: string) => void;
  tokenStore?: ITokenStore;
  fetch?: typeof fetch;
  scope?: string;
  /** Test seam: replaces the poll timer. Production leaves this unset. */
  sleep?: (ms: number) => Promise<void>;
}

export type AuthorizationCodeLoginOptions = Omit<
  AuthorizationCodeFlowOptions,
  'fetchImpl' | 'baseUrl'
> & {
  baseUrl: string;
  tokenStore?: ITokenStore;
  fetch?: typeof fetch;
};

export interface ClientCredentialsOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  tokenStore?: ITokenStore;
  fetch?: typeof fetch;
}

/**
 * Resolve the fetch to use. The global is wrapped rather than passed by
 * reference: a detached `globalThis.fetch` throws "Illegal invocation" in
 * browsers.
 */
function resolveFetch(injected?: typeof fetch): typeof fetch {
  if (injected) return injected;
  if (typeof globalThis.fetch !== 'function') {
    throw new ShipError({
      kind: 'server',
      code: 'no_fetch',
      message:
        'No global fetch is available. Use Node 20+, or pass a fetch implementation via the `fetch` option.',
      status: 0,
    });
  }
  return (input, init) => globalThis.fetch(input, init);
}

export class ShipClient {
  readonly documents: DocumentsClient;
  readonly issues: IssuesClient;
  readonly sprints: SprintsClient;
  /**
   * PRE-RELEASE. The server routes these methods call (/api/v1/webhooks*) are
   * not implemented yet — they ship with the webhooks slice. Calling them today
   * returns 404. Kept on the client so the CLI and the TTFE drill can be built
   * against the final shape, but do not treat it as available.
   */
  readonly webhooks: WebhooksClient;

  /** Normalized origin (no trailing slash, no /api/v1). */
  readonly baseUrl: string;
  /** Exposed so a CLI can `clear()` on logout without holding its own copy. */
  readonly tokenStore: ITokenStore;

  private readonly http: HttpClient;

  constructor(options: ShipClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);

    // A bare `token` with no store still gets a store, so refresh and logout
    // have somewhere to write. When both are supplied the store wins and the
    // token is only the fallback for an empty store.
    this.tokenStore =
      options.tokenStore ??
      new MemoryTokenStore(options.token ? { access_token: options.token } : null);

    const httpOptions: ConstructorParameters<typeof HttpClient>[0] = {
      baseUrl: this.baseUrl,
      tokenStore: this.tokenStore,
      fetchImpl: resolveFetch(options.fetch),
    };
    if (options.token !== undefined) httpOptions.staticToken = options.token;
    if (options.clientId !== undefined) httpOptions.clientId = options.clientId;
    if (options.clientSecret !== undefined) httpOptions.clientSecret = options.clientSecret;

    this.http = new HttpClient(httpOptions);

    this.documents = new DocumentsClient(this.http);
    this.issues = new IssuesClient(this.http);
    this.sprints = new SprintsClient(this.http);
    this.webhooks = new WebhooksClient(this.http);
  }

  /**
   * GET /api/v1/me — the authenticated principal behind the current token.
   *
   * This is the SDK's smoke test: if `me()` returns a typed user, the token
   * is valid, the base URL is right, and the whole request pipeline works.
   */
  me(): Promise<ShipUser> {
    return this.http.send<ShipUser>(SDK_ROUTES.getMe.method, SDK_ROUTES.getMe.path);
  }

  /**
   * Device Grant (RFC 8628) — the flow for a CLI on a machine with no
   * browser, and what `ship login` runs.
   *
   * `onUserCode` fires once, as soon as there is something to show the user;
   * the returned promise settles when they approve (or the code expires).
   */
  static async deviceLogin(options: DeviceLoginOptions): Promise<ShipClient> {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const fetchImpl = resolveFetch(options.fetch);
    const tokenStore = options.tokenStore ?? new MemoryTokenStore();

    const flowOptions: Parameters<typeof runDeviceFlow>[0] = {
      baseUrl,
      clientId: options.clientId,
      onUserCode: options.onUserCode,
      fetchImpl,
    };
    if (options.scope !== undefined) flowOptions.scope = options.scope;
    if (options.sleep !== undefined) flowOptions.sleep = options.sleep;

    const tokens = await runDeviceFlow(flowOptions);
    await tokenStore.set(tokens);

    return new ShipClient({ baseUrl, tokenStore, fetch: fetchImpl, clientId: options.clientId });
  }

  /**
   * Authorization Code + PKCE — the browser flow (the SPA demo), and the
   * flow any third-party app acting for a user must use.
   */
  static async authorizationCodeFlow(options: AuthorizationCodeLoginOptions): Promise<ShipClient> {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const fetchImpl = resolveFetch(options.fetch);
    const tokenStore = options.tokenStore ?? new MemoryTokenStore();

    const flowOptions: AuthorizationCodeFlowOptions = {
      baseUrl,
      clientId: options.clientId,
      redirectUri: options.redirectUri,
      onAuthorizeUrl: options.onAuthorizeUrl,
      waitForRedirect: options.waitForRedirect,
      fetchImpl,
    };
    if (options.clientSecret !== undefined) flowOptions.clientSecret = options.clientSecret;
    if (options.scope !== undefined) flowOptions.scope = options.scope;

    const tokens = await runAuthorizationCodeFlow(flowOptions);
    await tokenStore.set(tokens);

    const client: ShipClientOptions = {
      baseUrl,
      tokenStore,
      fetch: fetchImpl,
      clientId: options.clientId,
    };
    if (options.clientSecret !== undefined) client.clientSecret = options.clientSecret;
    return new ShipClient(client);
  }

  /**
   * Client Credentials — machine-to-machine, no user. This is how the agent
   * authenticates as a platform citizen rather than borrowing a human's
   * session.
   */
  static async clientCredentials(options: ClientCredentialsOptions): Promise<ShipClient> {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const fetchImpl = resolveFetch(options.fetch);
    const tokenStore = options.tokenStore ?? new MemoryTokenStore();

    const flowOptions: Parameters<typeof runClientCredentials>[0] = {
      baseUrl,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      fetchImpl,
    };
    if (options.scope !== undefined) flowOptions.scope = options.scope;

    const tokens = await runClientCredentials(flowOptions);
    await tokenStore.set(tokens);

    return new ShipClient({
      baseUrl,
      tokenStore,
      fetch: fetchImpl,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    });
  }
}
