/**
 * The one place the SDK talks to the network.
 *
 * Every resource method routes through here, which is what makes four
 * cross-cutting behaviours single-sourced instead of copy-pasted per method:
 * bearer injection, the JSON envelope, ShipError translation, and refresh.
 *
 * Zero runtime dependencies: this is global `fetch` (Node 20+) and nothing
 * else. A caller may inject their own `fetch` — that is the seam every test
 * in this package uses, and the seam a consumer uses for proxies, retries or
 * request logging.
 */
import { ShipError } from './errors.js';
import { refreshTokens } from './oauth.js';
import type { ITokenStore } from './token-store.js';
import type { Tokens } from './types.js';

export const DEFAULT_API_PREFIX = '/api/v1';

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** Epoch seconds at which the window resets, as sent by the server. */
  reset: number | null;
  retryAfterSeconds: number | null;
}

export interface HttpResponse<T> {
  data: T;
  status: number;
  requestId: string;
  rateLimit: RateLimitInfo;
}

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export interface SendOptions {
  query?: QueryParams;
  body?: unknown;
  headers?: Record<string, string>;
  /** Set false for endpoints that must not carry a bearer token. */
  auth?: boolean;
}

export interface HttpClientOptions {
  /** Origin only — no trailing slash, no /api/v1. */
  baseUrl: string;
  tokenStore: ITokenStore;
  fetchImpl: typeof fetch;
  /** Token handed straight to the constructor; used when the store is empty. */
  staticToken?: string;
  clientId?: string;
  clientSecret?: string;
  apiPrefix?: string;
}

/**
 * Accept anything a human would paste — `https://host/`, `https://host/api/v1`
 * — and reduce it to the origin the client composes paths onto.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/api\/v1$/, '');
}

export function buildQueryString(query: QueryParams | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function readRateLimit(headers: Headers): RateLimitInfo {
  return {
    limit: headerNumber(headers, 'x-ratelimit-limit'),
    remaining: headerNumber(headers, 'x-ratelimit-remaining'),
    reset: headerNumber(headers, 'x-ratelimit-reset'),
    retryAfterSeconds: headerNumber(headers, 'retry-after'),
  };
}

type Attempt<T> = { ok: true; response: HttpResponse<T> } | { ok: false; error: ShipError };

export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiPrefix: string;
  private readonly tokenStore: ITokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly staticToken: string | undefined;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;

  /**
   * The single-flight slot. Non-null exactly while a refresh is in the air.
   */
  private refreshInFlight: Promise<Tokens | null> | null = null;

  constructor(options: HttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiPrefix = options.apiPrefix ?? DEFAULT_API_PREFIX;
    this.tokenStore = options.tokenStore;
    this.fetchImpl = options.fetchImpl;
    this.staticToken = options.staticToken;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
  }

  /** Fully-qualified URL for a manifest path such as `/documents/{id}`. */
  url(path: string, query?: QueryParams): string {
    return `${this.baseUrl}${this.apiPrefix}${path}${buildQueryString(query)}`;
  }

  async send<T>(method: string, path: string, options: SendOptions = {}): Promise<T> {
    const result = await this.sendWithMeta<T>(method, path, options);
    return result.data;
  }

  /**
   * The full request pipeline, including the one-shot refresh retry.
   *
   * Retry policy is deliberately narrow: exactly one retry, only on 401, only
   * when a refresh token exists. Retrying 5xx or 429 here would hide the
   * server's own back-off signalling from the caller, who is better placed to
   * decide (and who gets `retryAfterSeconds` to decide with).
   */
  async sendWithMeta<T>(
    method: string,
    path: string,
    options: SendOptions = {}
  ): Promise<HttpResponse<T>> {
    const authenticated = options.auth !== false;
    const first = await this.attempt<T>(method, path, options, authenticated);
    if (first.ok) return first.response;

    if (!authenticated || first.error.status !== 401) throw first.error;

    const stored = await this.tokenStore.get();
    if (!stored?.refresh_token) throw first.error;

    const refreshed = await this.refresh();
    if (!refreshed) throw first.error;

    const second = await this.attempt<T>(method, path, options, authenticated);
    if (second.ok) return second.response;
    throw second.error;
  }

  /**
   * Single-flight refresh — the threading model, stated once.
   *
   * JavaScript is single-threaded and a function body runs to completion
   * between `await` boundaries. That is the whole guarantee this relies on:
   * the read of `refreshInFlight`, the call to `refreshTokens()`, and the
   * write back into the slot all happen in one uninterrupted synchronous run,
   * so two concurrent 401s cannot both observe an empty slot.
   *
   * Consequence: the first 401 to arrive starts exactly one POST to
   * /oauth/token; every 401 that lands while that POST is outstanding awaits
   * the SAME promise and then retries with the same new token. With N
   * concurrent in-flight calls that is 1 refresh, not N — which matters
   * because refresh tokens rotate, and N parallel refreshes would race to
   * invalidate each other and trip the token-family kill switch.
   *
   * The slot is cleared only after the promise settles, and via a derived
   * chain that already has a `.catch`, so a rejected refresh never surfaces
   * as an unhandled rejection and the next 401 is free to try again.
   */
  private refresh(): Promise<Tokens | null> {
    const existing = this.refreshInFlight;
    if (existing) return existing;

    const options: Parameters<typeof refreshTokens>[0] = {
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      tokenStore: this.tokenStore,
    };
    if (this.clientId !== undefined) options.clientId = this.clientId;
    if (this.clientSecret !== undefined) options.clientSecret = this.clientSecret;

    const inflight = refreshTokens(options);
    this.refreshInFlight = inflight;
    void inflight
      .catch(() => undefined)
      .finally(() => {
        if (this.refreshInFlight === inflight) this.refreshInFlight = null;
      });
    return inflight;
  }

  private async accessToken(): Promise<string | null> {
    const stored = await this.tokenStore.get();
    if (stored && typeof stored.access_token === 'string' && stored.access_token.length > 0) {
      return stored.access_token;
    }
    return this.staticToken ?? null;
  }

  private async attempt<T>(
    method: string,
    path: string,
    options: SendOptions,
    authenticated: boolean
  ): Promise<Attempt<T>> {
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };

    if (authenticated) {
      const token = await this.accessToken();
      if (token) headers['authorization'] = `Bearer ${token}`;
    }

    const init: RequestInit = { method: method.toUpperCase(), headers };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, options.query), init);
    } catch (cause) {
      return { ok: false, error: ShipError.network(cause) };
    }

    const rateLimit = readRateLimit(res.headers);
    const body = await readJsonBody(res);

    if (!res.ok) {
      const retryAfter = rateLimit.retryAfterSeconds ?? undefined;
      const error = ShipError.fromResponse(res.status, body, retryAfter);
      return { ok: false, error };
    }

    const requestId = requestIdFrom(res, body);
    return { ok: true, response: { data: body as T, status: res.status, requestId, rateLimit } };
  }
}

async function readJsonBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A proxy's HTML error page, a gateway timeout body, etc. The status
    // still drives a correct ShipError; the unparsable text is not useful.
    return undefined;
  }
}

function requestIdFrom(res: Response, body: unknown): string {
  const header = res.headers.get('x-request-id');
  if (header) return header;
  if (typeof body === 'object' && body !== null) {
    const candidate = (body as Record<string, unknown>)['request_id'];
    if (typeof candidate === 'string') return candidate;
  }
  return '';
}
