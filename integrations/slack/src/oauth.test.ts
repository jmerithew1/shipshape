/**
 * OAuth install-flow tests. Slack is a fake `fetch`; nothing leaves the process.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  createOAuthRouter,
  MemoryInstallationStore,
  StateStore,
  type Installation,
  type OAuthConfig,
} from './oauth.js';
import type { FetchLike } from './slack.js';

const CONFIG: OAuthConfig = {
  clientId: '123.456',
  clientSecret: 'sekrit',
  redirectUri: 'https://hooks.example.com/slack/oauth/callback',
};

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

interface Harness {
  url: string;
  store: MemoryInstallationStore;
  exchanges: { url: string; body: string }[];
  installed: Installation[];
}

function harness(
  options: {
    accessResponse?: { status: number; body: string };
    accessThrows?: boolean;
    state?: string;
    stateStore?: StateStore;
    configOverrides?: Partial<OAuthConfig>;
  } = {}
): Promise<Harness> {
  const store = new MemoryInstallationStore();
  const exchanges: { url: string; body: string }[] = [];
  const installed: Installation[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    exchanges.push({ url: input, body: init?.body ?? '' });
    if (options.accessThrows) throw new Error('ECONNREFUSED');
    const response = options.accessResponse ?? {
      status: 200,
      body: JSON.stringify({
        ok: true,
        access_token: 'xoxb-installed-token',
        bot_user_id: 'U0BOT',
        team: { id: 'T0TEAM', name: 'Acme' },
      }),
    };
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body,
    };
  };

  const app = express();
  app.use(
    createOAuthRouter({
      config: { ...CONFIG, ...options.configOverrides },
      store,
      fetchImpl,
      logger: () => {},
      ...(options.state ? { generateState: () => options.state as string } : {}),
      ...(options.stateStore ? { stateStore: options.stateStore } : {}),
      onInstalled: (installation) => installed.push(installation),
    })
  );

  const server = app.listen(0);
  openServers.push(server);
  return new Promise<Harness>((resolve) => {
    server.once('listening', () => {
      const address = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${address.port}`, store, exchanges, installed });
    });
  });
}

// ── Authorize URL ───────────────────────────────────────────────────────────

describe('buildAuthorizeUrl', () => {
  it('carries client_id, scopes, redirect_uri and state', () => {
    const url = new URL(buildAuthorizeUrl(CONFIG, 'st4te'));
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe('123.456');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('scope')).toContain('chat:write');
  });
});

// ── Install ─────────────────────────────────────────────────────────────────

describe('GET /slack/install', () => {
  it('redirects to Slack with a state parameter', async () => {
    const { url } = await harness({ state: 'st4te' });

    const response = await fetch(`${url}/slack/install`, { redirect: 'manual' });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.host).toBe('slack.com');
    expect(location.searchParams.get('state')).toBe('st4te');
  });

  it('mints a different state on every visit', async () => {
    const { url } = await harness();
    const first = await fetch(`${url}/slack/install`, { redirect: 'manual' });
    const second = await fetch(`${url}/slack/install`, { redirect: 'manual' });

    const stateOf = (r: Response): string | null =>
      new URL(r.headers.get('location') ?? '').searchParams.get('state');

    expect(stateOf(first)).not.toBe(stateOf(second));
    expect((stateOf(first) ?? '').length).toBeGreaterThanOrEqual(32);
  });
});

// ── Callback ────────────────────────────────────────────────────────────────

describe('GET /slack/oauth/callback', () => {
  it('exchanges the code and stores the bot token', async () => {
    const h = await harness({ state: 'st4te' });
    await fetch(`${h.url}/slack/install`, { redirect: 'manual' });

    const response = await fetch(`${h.url}/slack/oauth/callback?code=c0de&state=st4te`);

    expect(response.status).toBe(200);
    expect(h.exchanges).toHaveLength(1);
    expect(h.exchanges[0]!.url).toBe('https://slack.com/api/oauth.v2.access');

    const body = new URLSearchParams(h.exchanges[0]!.body);
    expect(body.get('code')).toBe('c0de');
    expect(body.get('client_secret')).toBe('sekrit');
    expect(body.get('redirect_uri')).toBe(CONFIG.redirectUri);

    const installation = await h.store.get('T0TEAM');
    expect(installation?.bot_token).toBe('xoxb-installed-token');
    expect(h.installed).toHaveLength(1);
  });

  it('rejects a callback whose state was never issued, without exchanging the code', async () => {
    // The CSRF case: an attacker-crafted callback URL must not reach Slack's
    // token endpoint at all, or this integration ends up posting a workspace's
    // titles into the attacker's Slack.
    const h = await harness({ state: 'st4te' });

    const response = await fetch(`${h.url}/slack/oauth/callback?code=c0de&state=forged`);

    expect(response.status).toBe(400);
    expect(h.exchanges).toHaveLength(0);
    expect(await h.store.latest()).toBeUndefined();
  });

  it('rejects a missing state', async () => {
    const h = await harness({ state: 'st4te' });
    const response = await fetch(`${h.url}/slack/oauth/callback?code=c0de`);
    expect(response.status).toBe(400);
    expect(h.exchanges).toHaveLength(0);
  });

  it('rejects a replayed state — it is single-use', async () => {
    const h = await harness({ state: 'st4te' });
    await fetch(`${h.url}/slack/install`, { redirect: 'manual' });

    const first = await fetch(`${h.url}/slack/oauth/callback?code=c0de&state=st4te`);
    const second = await fetch(`${h.url}/slack/oauth/callback?code=c0de&state=st4te`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(h.exchanges).toHaveLength(1);
  });

  it('rejects an expired state', async () => {
    let now = 1_000_000;
    const stateStore = new StateStore(60_000, () => now);
    const h = await harness({ state: 'st4te', stateStore });
    await fetch(`${h.url}/slack/install`, { redirect: 'manual' });

    now += 120_000; // past the TTL

    const response = await fetch(`${h.url}/slack/oauth/callback?code=c0de&state=st4te`);
    expect(response.status).toBe(400);
    expect(h.exchanges).toHaveLength(0);
  });

  it('reports a cancelled install without touching the token endpoint', async () => {
    const h = await harness({ state: 'st4te' });
    const response = await fetch(`${h.url}/slack/oauth/callback?error=access_denied&state=st4te`);
    expect(response.status).toBe(400);
    expect(h.exchanges).toHaveLength(0);
  });

  it('returns 502 when Slack refuses the exchange', async () => {
    const h = await harness({
      state: 'st4te',
      accessResponse: { status: 200, body: JSON.stringify({ ok: false, error: 'invalid_code' }) },
    });
    await fetch(`${h.url}/slack/install`, { redirect: 'manual' });

    const response = await fetch(`${h.url}/slack/oauth/callback?code=c0de&state=st4te`);
    expect(response.status).toBe(502);
    expect(await h.store.latest()).toBeUndefined();
  });

  it('returns 502 when Slack is unreachable', async () => {
    const h = await harness({ state: 'st4te', accessThrows: true });
    await fetch(`${h.url}/slack/install`, { redirect: 'manual' });

    const response = await fetch(`${h.url}/slack/oauth/callback?code=c0de&state=st4te`);
    expect(response.status).toBe(502);
  });

  it('never echoes the bot token back to the browser', async () => {
    const h = await harness({ state: 'st4te' });
    await fetch(`${h.url}/slack/install`, { redirect: 'manual' });

    const response = await fetch(`${h.url}/slack/oauth/callback?code=c0de&state=st4te`);
    expect(await response.text()).not.toContain('xoxb-installed-token');
  });
});

// ── State store ─────────────────────────────────────────────────────────────

describe('StateStore', () => {
  it('consumes a value exactly once', () => {
    const store = new StateStore();
    store.issue('abc');
    expect(store.consume('abc')).toBe(true);
    expect(store.consume('abc')).toBe(false);
  });

  it('bounds its size so an open endpoint cannot grow the heap forever', () => {
    const now = 0;
    const store = new StateStore(60_000, () => now, 2);
    store.issue('a');
    store.issue('b');
    store.issue('c');
    expect(store.consume('a')).toBe(false);
    expect(store.consume('c')).toBe(true);
  });
});

// ── Security review fixes (unauthenticated install + workspace hijack) ───────
describe('security review — install is gated and workspace-pinned', () => {
  it('refuses /slack/install without the operator key when a secret is set', async () => {
    const { url } = await harness({ configOverrides: { installSecret: 'op-secret' } });
    const res = await fetch(`${url}/slack/install`, { redirect: 'manual' });
    expect(res.status).toBe(403);
  });

  it('refuses /slack/install with a WRONG operator key', async () => {
    const { url } = await harness({ configOverrides: { installSecret: 'op-secret' } });
    const res = await fetch(`${url}/slack/install?key=nope`, { redirect: 'manual' });
    expect(res.status).toBe(403);
  });

  it('allows /slack/install with the correct operator key', async () => {
    const { url } = await harness({ configOverrides: { installSecret: 'op-secret' } });
    const res = await fetch(`${url}/slack/install?key=op-secret`, { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('refuses a completed install for a workspace it was not configured to serve', async () => {
    // Slack's fake response is team T0TEAM; pin to a DIFFERENT workspace.
    const state = 'fixed-state';
    const { url, store, installed } = await harness({
      state,
      configOverrides: { expectedTeamId: 'T-OTHER' },
    });
    // Mint the state via /install, then complete the callback.
    await fetch(`${url}/slack/install`, { redirect: 'manual' });
    const res = await fetch(`${url}/slack/oauth/callback?code=c&state=${state}`, { redirect: 'manual' });
    expect(res.status).toBe(403);
    // The hijack is fully prevented: nothing saved, nothing swapped.
    expect(await store.latest()).toBeUndefined();
    expect(installed).toHaveLength(0);
  });

  it('accepts a completed install for the pinned workspace', async () => {
    const state = 'fixed-state-2';
    const { url, store } = await harness({ state, configOverrides: { expectedTeamId: 'T0TEAM' } });
    await fetch(`${url}/slack/install`, { redirect: 'manual' });
    const res = await fetch(`${url}/slack/oauth/callback?code=c&state=${state}`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect((await store.latest())?.team_id).toBe('T0TEAM');
  });
});
