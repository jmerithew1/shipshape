import { describe, expect, it, vi } from 'vitest';
import { ShipError } from './errors.js';
import { HttpClient, normalizeBaseUrl } from './http.js';
import { MemoryTokenStore } from './token-store.js';

const BASE_URL = 'https://ship.example.com';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function record(input: Parameters<typeof fetch>[0], init?: RequestInit): Call {
  return {
    url: typeof input === 'string' ? input : input.toString(),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof init?.body === 'string' ? init.body : undefined,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function clientWith(
  fetchImpl: typeof fetch,
  tokens: ConstructorParameters<typeof MemoryTokenStore>[0] = null
) {
  const tokenStore = new MemoryTokenStore(tokens);
  const http = new HttpClient({ baseUrl: BASE_URL, tokenStore, fetchImpl });
  return { http, tokenStore };
}

describe('normalizeBaseUrl', () => {
  it('reduces anything paste-able to a bare origin', () => {
    expect(normalizeBaseUrl('https://ship.example.com')).toBe(BASE_URL);
    expect(normalizeBaseUrl('https://ship.example.com/')).toBe(BASE_URL);
    expect(normalizeBaseUrl('https://ship.example.com///')).toBe(BASE_URL);
    expect(normalizeBaseUrl('https://ship.example.com/api/v1')).toBe(BASE_URL);
    expect(normalizeBaseUrl('  https://ship.example.com/api/v1/  ')).toBe(BASE_URL);
  });
});

describe('HttpClient requests', () => {
  it('attaches the bearer token and targets /api/v1', async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(record(input, init));
      return json({ id: 'usr_1' });
    }) as unknown as typeof fetch;

    const { http } = clientWith(fetchImpl, { access_token: 'tok_abc' });
    await http.send('get', '/me');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://ship.example.com/api/v1/me');
    expect(calls[0]?.headers['authorization']).toBe('Bearer tok_abc');
    expect(calls[0]?.method).toBe('GET');
  });

  it('omits the Authorization header when there is no token at all', async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(record(input, init));
      return json({ ok: true });
    }) as unknown as typeof fetch;

    const { http } = clientWith(fetchImpl);
    await http.send('get', '/me');
    expect(calls[0]?.headers['authorization']).toBeUndefined();
  });

  it('serialises query params and skips undefined ones', async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(record(input, init));
      return json({ data: [], next_cursor: null });
    }) as unknown as typeof fetch;

    const { http } = clientWith(fetchImpl, { access_token: 't' });
    await http.send('get', '/documents', {
      query: { limit: 25, cursor: undefined, state: 'active' },
    });

    expect(calls[0]?.url).toBe('https://ship.example.com/api/v1/documents?limit=25&state=active');
  });

  it('sends a JSON body with the right content-type on writes', async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(record(input, init));
      return json({ id: 'doc_1' }, { status: 201 });
    }) as unknown as typeof fetch;

    const { http } = clientWith(fetchImpl, { access_token: 't' });
    await http.send('post', '/documents', { body: { title: 'Spec' } });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toBe('{"title":"Spec"}');
  });

  it('tolerates a 204 with no body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const { http } = clientWith(fetchImpl, { access_token: 't' });
    await expect(http.send('delete', '/webhooks/wh_1')).resolves.toBeUndefined();
  });

  it('turns a network failure into a ShipError instead of a raw TypeError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const { http } = clientWith(fetchImpl, { access_token: 't' });

    const error = await http.send('get', '/me').catch((e: unknown) => e);
    expect(ShipError.is(error)).toBe(true);
    expect((error as ShipError).kind).toBe('server');
    expect((error as ShipError).code).toBe('network_error');
  });
});

describe('HttpClient error surfacing', () => {
  it('surfaces retryAfterSeconds and the rate-limit headers on a 429', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 'rate_limited',
            message: 'Rate limit exceeded',
            request_id: 'req_42',
            details: { retry_after_seconds: 30 },
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': '30',
              'x-ratelimit-limit': '100',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': '1786000000',
            },
          }
        )
    ) as unknown as typeof fetch;

    const { http } = clientWith(fetchImpl, { access_token: 't' });
    const error = (await http.send('get', '/documents').catch((e: unknown) => e)) as ShipError;

    expect(ShipError.is(error)).toBe(true);
    expect(error.kind).toBe('rate_limit');
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.requestId).toBe('req_42');
  });

  it('reports rate-limit headers on successful responses too', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [], next_cursor: null }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit': '100',
            'x-ratelimit-remaining': '97',
            'x-ratelimit-reset': '1786000000',
            'x-request-id': 'req_ok',
          },
        })
    ) as unknown as typeof fetch;

    const { http } = clientWith(fetchImpl, { access_token: 't' });
    const result = await http.sendWithMeta('get', '/documents');

    expect(result.rateLimit).toEqual({
      limit: 100,
      remaining: 97,
      reset: 1786000000,
      retryAfterSeconds: null,
    });
    expect(result.requestId).toBe('req_ok');
  });

  it('does not attempt a refresh on a 401 when there is no refresh token', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ code: 'unauthorized', message: 'nope', request_id: 'req_1' }, { status: 401 })
    ) as unknown as typeof fetch;

    const { http } = clientWith(fetchImpl, { access_token: 'dead' });
    const error = (await http.send('get', '/me').catch((e: unknown) => e)) as ShipError;

    expect(error.kind).toBe('auth');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('HttpClient single-flight refresh', () => {
  /**
   * The fixture: the old token 401s with token_expired, /oauth/token issues a
   * new pair (after a real timer tick, so the refresh is genuinely in flight
   * while the other callers arrive), and the new token succeeds.
   */
  function refreshFixture() {
    const state = { refreshCalls: 0, apiCalls: 0, refreshStatus: 200 };
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const call = record(input, init);

      if (call.url.endsWith('/oauth/token')) {
        state.refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (state.refreshStatus !== 200) {
          return json({ error: 'invalid_grant' }, { status: state.refreshStatus });
        }
        return json({ access_token: 'tok_new', refresh_token: 'ref_new', expires_in: 3600 });
      }

      state.apiCalls += 1;
      if (call.headers['authorization'] === 'Bearer tok_new') {
        return json({ id: 'usr_1', email: 'a@b.c', workspace_id: 'ws_1' });
      }
      return json(
        { code: 'token_expired', message: 'Access token has expired', request_id: 'req_x' },
        { status: 401 }
      );
    }) as unknown as typeof fetch;

    return { state, fetchImpl };
  }

  it('refreshes once and retries the call', async () => {
    const { state, fetchImpl } = refreshFixture();
    const { http, tokenStore } = clientWith(fetchImpl, {
      access_token: 'tok_old',
      refresh_token: 'ref_old',
    });

    await expect(http.send('get', '/me')).resolves.toMatchObject({ id: 'usr_1' });

    expect(state.refreshCalls).toBe(1);
    expect(state.apiCalls).toBe(2); // the 401, then the retry
    expect((await tokenStore.get())?.access_token).toBe('tok_new');
    expect((await tokenStore.get())?.refresh_token).toBe('ref_new');
  });

  it('fires exactly ONE refresh across N concurrent 401s, then retries them all', async () => {
    const { state, fetchImpl } = refreshFixture();
    const { http } = clientWith(fetchImpl, {
      access_token: 'tok_old',
      refresh_token: 'ref_old',
    });

    const concurrency = 8;
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => http.send<{ id: string }>('get', '/me'))
    );

    expect(results).toHaveLength(concurrency);
    for (const result of results) expect(result.id).toBe('usr_1');

    // The whole point: N callers, one rotation. N refreshes would race each
    // other to invalidate the rotating refresh token.
    expect(state.refreshCalls).toBe(1);
    expect(state.apiCalls).toBe(concurrency * 2);
  });

  it('starts a fresh refresh for a later 401 once the first has settled', async () => {
    const { state, fetchImpl } = refreshFixture();
    const { http, tokenStore } = clientWith(fetchImpl, {
      access_token: 'tok_old',
      refresh_token: 'ref_old',
    });

    await http.send('get', '/me');
    expect(state.refreshCalls).toBe(1);

    // Simulate the new token expiring later: the single-flight slot must have
    // been released, not latched.
    await tokenStore.set({ access_token: 'tok_old', refresh_token: 'ref_old' });
    await http.send('get', '/me');
    expect(state.refreshCalls).toBe(2);
  });

  it('clears the store and reports an auth failure when the refresh token is dead', async () => {
    const { state, fetchImpl } = refreshFixture();
    state.refreshStatus = 400;

    const { http, tokenStore } = clientWith(fetchImpl, {
      access_token: 'tok_old',
      refresh_token: 'ref_revoked',
    });

    const error = (await http.send('get', '/me').catch((e: unknown) => e)) as ShipError;
    expect(ShipError.is(error)).toBe(true);
    expect(error.kind).toBe('auth');
    expect(error.code).toBe('invalid_grant');
    expect(await tokenStore.get()).toBeNull();
  });
});
