import { describe, expect, it, vi } from 'vitest';
import { ShipClient } from './client.js';
import { ShipError } from './errors.js';
import { collect } from './pagination.js';
import { MemoryTokenStore } from './token-store.js';
import type { ShipUser } from './types.js';

const BASE_URL = 'https://ship.example.com';

interface Seen {
  url: string;
  method: string;
  authorization: string | undefined;
  body: string | undefined;
}

function see(input: Parameters<typeof fetch>[0], init?: RequestInit): Seen {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return {
    url: typeof input === 'string' ? input : input.toString(),
    method: init?.method ?? 'GET',
    authorization: headers['authorization'],
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

const USER: ShipUser = {
  id: 'usr_01HZ',
  email: 'james@example.com',
  name: 'James',
  workspace_id: 'ws_01HZ',
};

describe('ShipClient.me — the MVP gate', () => {
  it('GETs /api/v1/me with the bearer token and returns the typed user', async () => {
    const seen: Seen[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(see(input, init));
      return json(USER);
    }) as unknown as typeof fetch;

    const ship = new ShipClient({ token: 'tok_grader', baseUrl: BASE_URL, fetch: fetchImpl });
    const me = await ship.me();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toBe('https://ship.example.com/api/v1/me');
    expect(seen[0]?.authorization).toBe('Bearer tok_grader');

    // Typed, not `any`: these property reads are the assertion.
    expect(me.id).toBe('usr_01HZ');
    expect(me.email).toBe('james@example.com');
    expect(me.workspace_id).toBe('ws_01HZ');
    expect(me.name).toBe('James');
  });

  it('normalises a base URL that already carries /api/v1', async () => {
    const seen: Seen[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(see(input, init));
      return json(USER);
    }) as unknown as typeof fetch;

    const ship = new ShipClient({
      token: 't',
      baseUrl: 'https://ship.example.com/api/v1/',
      fetch: fetchImpl,
    });
    await ship.me();
    expect(seen[0]?.url).toBe('https://ship.example.com/api/v1/me');
  });

  it('raises a typed auth error when the token is rejected', async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        { code: 'unauthorized', message: 'Authentication required', request_id: 'req_9' },
        { status: 401 }
      )
    ) as unknown as typeof fetch;

    const ship = new ShipClient({ token: 'bad', baseUrl: BASE_URL, fetch: fetchImpl });
    const error = (await ship.me().catch((e: unknown) => e)) as ShipError;

    expect(ShipError.is(error)).toBe(true);
    expect(error.kind).toBe('auth');
    expect(error.requestId).toBe('req_9');
  });

  it('prefers a stored token over the constructor token', async () => {
    const seen: Seen[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(see(input, init));
      return json(USER);
    }) as unknown as typeof fetch;

    const tokenStore = new MemoryTokenStore({ access_token: 'tok_from_store' });
    const ship = new ShipClient({ token: 'tok_ctor', baseUrl: BASE_URL, fetch: fetchImpl, tokenStore });
    await ship.me();
    expect(seen[0]?.authorization).toBe('Bearer tok_from_store');
  });
});

describe('ShipClient resource clients', () => {
  it('exposes documents, issues, sprints and webhooks', () => {
    const ship = new ShipClient({ token: 't', baseUrl: BASE_URL, fetch: (async () => json({})) as unknown as typeof fetch });
    expect(ship.documents).toBeDefined();
    expect(ship.issues).toBeDefined();
    expect(ship.sprints).toBeDefined();
    expect(ship.webhooks).toBeDefined();
  });

  it('iterates documents across pages without the caller touching a cursor', async () => {
    const pages = [
      { data: [{ id: 'doc_1' }, { id: 'doc_2' }], next_cursor: 'c1' },
      { data: [{ id: 'doc_3' }], next_cursor: null },
    ];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      urls.push(url);
      return json(url.includes('cursor=c1') ? pages[1] : pages[0]);
    }) as unknown as typeof fetch;

    const ship = new ShipClient({ token: 't', baseUrl: BASE_URL, fetch: fetchImpl });
    const ids = (await collect(ship.documents.iterate({ limit: 2 }))).map((d) => d.id);

    expect(ids).toEqual(['doc_1', 'doc_2', 'doc_3']);
    expect(urls[0]).toBe('https://ship.example.com/api/v1/documents?limit=2');
    expect(urls[1]).toBe('https://ship.example.com/api/v1/documents?limit=2&cursor=c1');
  });

  it('creates a webhook subscription and returns the one-time secret', async () => {
    const seen: Seen[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(see(input, init));
      return json(
        {
          id: 'wh_1',
          event_type: 'document.created',
          target_url: 'https://hooks.example.com/ship',
          created_at: '2026-08-12T00:00:00Z',
          secret: 'whsec_once',
        },
        { status: 201 }
      );
    }) as unknown as typeof fetch;

    const ship = new ShipClient({ token: 't', baseUrl: BASE_URL, fetch: fetchImpl });
    const webhook = await ship.webhooks.create({
      event_type: 'document.created',
      target_url: 'https://hooks.example.com/ship',
    });

    // The body field the API validates is `event_type`, not `event`.
    expect(JSON.parse(String(seen[0]?.body))).toMatchObject({ event_type: 'document.created' });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('https://ship.example.com/api/v1/webhooks');
    expect(webhook.secret).toBe('whsec_once');
  });
});

describe('ShipClient.deviceLogin', () => {
  /**
   * Fixture: the device endpoint issues a 1-second interval; the token
   * endpoint then answers slow_down, authorization_pending, and finally the
   * grant. The injected `sleep` records what the flow *would* have waited, so
   * the back-off is asserted without any wall-clock cost.
   */
  function deviceFixture(replies: Array<{ status: number; body: unknown }>) {
    const slept: number[] = [];
    let index = 0;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/oauth/device/code')) {
        return json({
          device_code: 'dev_abc',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://ship.example.com/device',
          verification_uri_complete: 'https://ship.example.com/device?user_code=WDJB-MJHT',
          expires_in: 900,
          interval: 1,
        });
      }
      const reply = replies[index++];
      if (!reply) throw new Error('device fixture ran out of replies');
      return json(reply.body, { status: reply.status });
    }) as unknown as typeof fetch;

    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
    };

    return { fetchImpl, sleep, slept };
  }

  it('polls until approved, honours slow_down, and persists tokens to the injected store', async () => {
    const { fetchImpl, sleep, slept } = deviceFixture([
      { status: 400, body: { error: 'slow_down' } },
      { status: 400, body: { error: 'authorization_pending' } },
      {
        status: 200,
        body: { access_token: 'tok_device', refresh_token: 'ref_device', expires_in: 3600 },
      },
    ]);

    const tokenStore = new MemoryTokenStore();
    const shown: Array<[string, string]> = [];

    const ship = await ShipClient.deviceLogin({
      baseUrl: BASE_URL,
      clientId: 'cli_ship',
      onUserCode: (code, verifyUrl) => shown.push([code, verifyUrl]),
      tokenStore,
      fetch: fetchImpl,
      sleep,
    });

    // The user is told once, immediately, and gets the pre-filled URL.
    expect(shown).toEqual([
      ['WDJB-MJHT', 'https://ship.example.com/device?user_code=WDJB-MJHT'],
    ]);

    // Interval starts at the server's 1s; slow_down widens it by RFC 8628's
    // mandated 5s and it stays widened for every later poll.
    expect(slept).toEqual([1000, 6000, 6000]);

    const stored = await tokenStore.get();
    expect(stored?.access_token).toBe('tok_device');
    expect(stored?.refresh_token).toBe('ref_device');
    expect(typeof stored?.expires_at).toBe('number');

    // The returned client is usable straight away.
    expect(ship).toBeInstanceOf(ShipClient);
    expect(ship.baseUrl).toBe(BASE_URL);
    expect(ship.tokenStore).toBe(tokenStore);
  });

  it('surfaces access_denied as a typed auth error', async () => {
    const { fetchImpl, sleep } = deviceFixture([
      { status: 400, body: { error: 'access_denied', error_description: 'User declined' } },
    ]);

    const error = (await ShipClient.deviceLogin({
      baseUrl: BASE_URL,
      clientId: 'cli_ship',
      onUserCode: () => undefined,
      fetch: fetchImpl,
      sleep,
    }).catch((e: unknown) => e)) as ShipError;

    expect(ShipError.is(error)).toBe(true);
    expect(error.kind).toBe('auth');
    expect(error.code).toBe('access_denied');
  });

  it('sends the device-code grant type when polling', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/oauth/device/code')) {
        return json({
          device_code: 'dev_abc',
          user_code: 'CODE',
          verification_uri: 'https://ship.example.com/device',
          expires_in: 900,
          interval: 1,
        });
      }
      if (typeof init?.body === 'string') bodies.push(init.body);
      return json({ access_token: 'tok', expires_in: 60 });
    }) as unknown as typeof fetch;

    await ShipClient.deviceLogin({
      baseUrl: BASE_URL,
      clientId: 'cli_ship',
      onUserCode: () => undefined,
      fetch: fetchImpl,
      sleep: async () => undefined,
    });

    const params = new URLSearchParams(bodies[0] ?? '');
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(params.get('device_code')).toBe('dev_abc');
    expect(params.get('client_id')).toBe('cli_ship');
  });
});

describe('ShipClient.clientCredentials', () => {
  it('exchanges client credentials and returns an authenticated client', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/oauth/token')) {
        if (typeof init?.body === 'string') bodies.push(init.body);
        return json({ access_token: 'tok_m2m', expires_in: 3600 });
      }
      return json(USER);
    }) as unknown as typeof fetch;

    const ship = await ShipClient.clientCredentials({
      baseUrl: BASE_URL,
      clientId: 'agent_app',
      clientSecret: 'shh',
      fetch: fetchImpl,
    });

    const params = new URLSearchParams(bodies[0] ?? '');
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('client_id')).toBe('agent_app');
    expect(params.get('client_secret')).toBe('shh');

    await expect(ship.me()).resolves.toMatchObject({ id: USER.id });
  });
});

describe('ShipClient.authorizationCodeFlow', () => {
  it('drives PKCE: S256 challenge on /authorize, verifier on /token', async () => {
    let authorizeUrl = '';
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/oauth/token')) {
        if (typeof init?.body === 'string') bodies.push(init.body);
        return json({ access_token: 'tok_pkce', refresh_token: 'ref_pkce', expires_in: 3600 });
      }
      return json(USER);
    }) as unknown as typeof fetch;

    const tokenStore = new MemoryTokenStore();
    const ship = await ShipClient.authorizationCodeFlow({
      baseUrl: BASE_URL,
      clientId: 'spa_app',
      redirectUri: 'https://app.example.com/callback',
      scope: 'documents:read',
      onAuthorizeUrl: (url) => {
        authorizeUrl = url;
      },
      waitForRedirect: async (state) => ({ code: 'auth_code_1', state }),
      tokenStore,
      fetch: fetchImpl,
    });

    const parsed = new URL(authorizeUrl);
    expect(parsed.pathname).toBe('/oauth/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('spa_app');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(parsed.searchParams.get('scope')).toBe('documents:read');

    const params = new URLSearchParams(bodies[0] ?? '');
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('auth_code_1');
    expect(params.get('code_verifier')).toBeTruthy();
    // The verifier is never sent to /authorize — only its hash is.
    expect(params.get('code_verifier')).not.toBe(parsed.searchParams.get('code_challenge'));

    expect((await tokenStore.get())?.access_token).toBe('tok_pkce');
    await expect(ship.me()).resolves.toMatchObject({ id: USER.id });
  });

  it('rejects a redirect whose state does not match (CSRF)', async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: 'nope' })) as unknown as typeof fetch;

    const error = (await ShipClient.authorizationCodeFlow({
      baseUrl: BASE_URL,
      clientId: 'spa_app',
      redirectUri: 'https://app.example.com/callback',
      onAuthorizeUrl: () => undefined,
      waitForRedirect: async () => ({ code: 'c', state: 'attacker_state' }),
      fetch: fetchImpl,
    }).catch((e: unknown) => e)) as ShipError;

    expect(ShipError.is(error)).toBe(true);
    expect(error.code).toBe('state_mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Regression (security scan, LOW / CWE-352). An ABSENT state used to skip the
  // check (the guard was `state !== undefined && state !== expected`), so an
  // attacker-crafted redirect carrying a valid code but no state bypassed CSRF
  // and reached the token exchange. A missing state is now a hard reject.
  it('rejects a redirect that omits state entirely (CSRF), without exchanging the code', async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: 'nope' })) as unknown as typeof fetch;

    const error = (await ShipClient.authorizationCodeFlow({
      baseUrl: BASE_URL,
      clientId: 'spa_app',
      redirectUri: 'https://app.example.com/callback',
      onAuthorizeUrl: () => undefined,
      // No `state` field at all — the dangerous case.
      waitForRedirect: async () => ({ code: 'c' }) as unknown as { code: string; state: string },
      fetch: fetchImpl,
    }).catch((e: unknown) => e)) as ShipError;

    expect(ShipError.is(error)).toBe(true);
    expect(error.code).toBe('state_mismatch');
    expect(fetchImpl).not.toHaveBeenCalled(); // code was never exchanged
  });
});
