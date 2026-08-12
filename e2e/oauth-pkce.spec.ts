/**
 * Authorization Code + PKCE, end to end (Week 6 MVP hard gate A2).
 *
 * The graded requirement is one sentence:
 *
 *   "Authorization Code + PKCE flow completes end-to-end via a Playwright
 *    test: /oauth/authorize → consent → /oauth/token → usable access token."
 *
 * Every hop below is a real HTTP round trip against the isolated per-worker
 * stack (testcontainer Postgres + built API + vite preview), driven the way a
 * real client drives it:
 *
 *   - The HUMAN half (/api/oauth-apps, GET /oauth/authorize, POST
 *     /oauth/authorize/decision) goes through `page.request`, which shares the
 *     browser context's cookie jar with a genuine form login. So the session
 *     cookie and the CSRF token flow exactly as they do from the consent
 *     screen — no fake auth middleware, no hand-forged session row.
 *   - The CLIENT half (POST /oauth/token, GET /api/v1/me) goes through the
 *     cookie-free `request` fixture. That separation is load-bearing: it
 *     proves the access token stands on its own and is not quietly riding the
 *     browser session. "Usable access token" has to mean usable by a party
 *     that has no session, or the requirement is satisfied by nothing.
 *
 * The negative cases are not garnish. An authorization server that issues
 * tokens correctly but ALSO issues them to the wrong verifier, on a replayed
 * code, or for scopes nobody consented to is not a working OAuth server — it
 * is an open door with a login page painted on it. Hence: wrong verifier,
 * replay, redirect_uri mismatch, denial, and scope escalation all assert the
 * refusal AND its RFC 6749 §5.2 error code.
 */

import crypto from 'node:crypto';
import { test, expect, Page, APIRequestContext } from './fixtures/isolated-env';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures of the flow itself
// ─────────────────────────────────────────────────────────────────────────────

const REDIRECT_URI = 'https://grader.example.test/callback';

/** What the app registers for. Deliberately WIDER than what we consent to. */
const APP_SCOPES = ['documents:read', 'documents:write', 'issues:read'];

/** What the user actually grants. `documents:write` is withheld on purpose. */
const GRANTED_SCOPES = ['documents:read', 'issues:read'];
const GRANTED_SCOPE_STRING = GRANTED_SCOPES.join(' ');

/**
 * A state value with a space and an ampersand in it. A server that builds its
 * redirect by string concatenation instead of URLSearchParams round-trips this
 * wrong, so the assertion is doing real work rather than comparing 'xyz'.
 */
const STATE = 'st_7f3a&next=/inbox one';

const SEEDED_EMAIL = 'dev@ship.local';
const SEEDED_PASSWORD = 'admin123';
const SEEDED_NAME = 'Dev User';

// ─────────────────────────────────────────────────────────────────────────────
// PKCE (RFC 7636 §4.1–4.2), S256 only
// ─────────────────────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes → 43 base64url chars, the RFC's recommended length. */
function createVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

function challengeFor(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

interface RegisteredApp {
  id: string;
  client_id: string;
  client_secret: string;
  requested_scopes: string[];
}

interface AuthorizeParams {
  clientId: string;
  codeChallenge: string;
  scope?: string;
  state?: string;
  redirectUri?: string;
  responseType?: string;
  codeChallengeMethod?: string;
}

interface Harness {
  /** Absolute API origin — /oauth is not proxied through the web preview. */
  apiUrl: string;
  /** Cookie-free client context: stands in for the CLI / SPA / desktop app. */
  client: APIRequestContext;
  registerApp(name: string, scopes?: string[]): Promise<RegisteredApp>;
  authorize(p: AuthorizeParams): Promise<import('@playwright/test').APIResponse>;
  decide(p: AuthorizeParams & { approve: boolean }): Promise<import('@playwright/test').APIResponse>;
  /** Consent all the way to a fresh, unused authorization code. */
  grantCode(p: AuthorizeParams): Promise<{ code: string; state: string | null; redirectTo: string }>;
  exchange(form: Record<string, string>): Promise<import('@playwright/test').APIResponse>;
  cleanup(): Promise<void>;
}

/** Log in through the real login form; returns the browser's cookie jar. */
async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill(SEEDED_EMAIL);
  await page.locator('#password').fill(SEEDED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 15000 });
}

async function createHarness(
  page: Page,
  client: APIRequestContext,
  apiUrl: string
): Promise<Harness> {
  await login(page);

  // csrf-sync issues the token against the express session; page.request shares
  // the browser jar, so the connect.sid it sets is carried automatically.
  const csrfRes = await page.request.get(`${apiUrl}/api/csrf-token`);
  expect(csrfRes.ok()).toBeTruthy();
  const csrfToken: string = (await csrfRes.json()).token;
  expect(csrfToken).toBeTruthy();

  const createdAppIds: string[] = [];
  const consented = (extra: Record<string, string> = {}) => ({
    'x-csrf-token': csrfToken,
    ...extra,
  });

  const bodyFor = (p: AuthorizeParams): Record<string, string> => {
    const body: Record<string, string> = {
      client_id: p.clientId,
      redirect_uri: p.redirectUri ?? REDIRECT_URI,
      code_challenge: p.codeChallenge,
      code_challenge_method: p.codeChallengeMethod ?? 'S256',
    };
    if (p.scope !== undefined) body.scope = p.scope;
    if (p.state !== undefined) body.state = p.state;
    return body;
  };

  const harness: Harness = {
    apiUrl,
    client,

    async registerApp(name, scopes = APP_SCOPES) {
      const res = await page.request.post(`${apiUrl}/api/oauth-apps`, {
        headers: consented(),
        data: { name, redirect_uris: [REDIRECT_URI], requested_scopes: scopes },
      });
      expect(res.status(), await res.text()).toBe(201);
      const data = (await res.json()).data;
      createdAppIds.push(data.id);
      return data as RegisteredApp;
    },

    async authorize(p) {
      const qs = new URLSearchParams({
        response_type: p.responseType ?? 'code',
        ...bodyFor(p),
      });
      return page.request.get(`${apiUrl}/oauth/authorize?${qs.toString()}`);
    },

    async decide(p) {
      return page.request.post(`${apiUrl}/oauth/authorize/decision`, {
        headers: consented(),
        data: { ...bodyFor(p), approve: p.approve },
      });
    },

    async grantCode(p) {
      const res = await harness.decide({ ...p, approve: true });
      expect(res.status(), await res.text()).toBe(200);
      const redirectTo: string = (await res.json()).redirect_to;
      const url = new URL(redirectTo);
      const code = url.searchParams.get('code');
      expect(code, `no code in ${redirectTo}`).toBeTruthy();
      return { code: code as string, state: url.searchParams.get('state'), redirectTo };
    },

    async exchange(form) {
      // Form-encoded, as RFC 6749 §4.1.3 specifies and stock clients send.
      return client.post(`${apiUrl}/oauth/token`, { form });
    },

    async cleanup() {
      // Deactivates the app and revokes every token it minted. The worker's
      // Postgres container is torn down anyway, but leaving live credentials
      // behind between tests in the same worker would let one test's token
      // silently satisfy another's assertion.
      for (const id of createdAppIds.splice(0)) {
        await page.request.delete(`${apiUrl}/api/oauth-apps/${id}`, { headers: consented() });
      }
    },
  };

  return harness;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

let h: Harness;

test.beforeEach(async ({ page, request, apiServer }) => {
  h = await createHarness(page, request, apiServer.url);
});

test.afterEach(async () => {
  await h?.cleanup();
});

test.describe('Authorization Code + PKCE (MVP gate A2)', () => {
  test('PKCE helper reproduces the RFC 7636 Appendix B reference vector', async () => {
    // If this fails, every other PKCE assertion in this file is meaningless:
    // a broken helper would make wrong verifiers "wrong" for the wrong reason.
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
    const v = createVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(challengeFor(v)).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
  });

  test('happy path: authorize → consent → token → usable access token', async () => {
    const verifier = createVerifier();
    const codeChallenge = challengeFor(verifier);
    const app = await h.registerApp('Gate A2 Happy Path');
    expect(app.client_id).toMatch(/^ship_app_/);

    // ── 1. GET /oauth/authorize — the consent CONTEXT ───────────────────────
    const authorizeRes = await h.authorize({
      clientId: app.client_id,
      scope: GRANTED_SCOPE_STRING,
      state: STATE,
      codeChallenge,
    });
    expect(authorizeRes.status(), await authorizeRes.text()).toBe(200);
    const consent = await authorizeRes.json();

    expect(consent.app_name).toBe('Gate A2 Happy Path');
    expect(consent.client_id).toBe(app.client_id);
    expect(consent.redirect_uri).toBe(REDIRECT_URI);
    expect(consent.state).toBe(STATE);
    expect(consent.code_challenge).toBe(codeChallenge);
    expect(consent.code_challenge_method).toBe('S256');

    // The screen must describe exactly what was asked for — no more (that would
    // over-grant) and no less (that would under-inform the human consenting).
    expect(consent.scopes.map((s: { scope: string }) => s.scope)).toEqual(GRANTED_SCOPES);
    for (const entry of consent.scopes) {
      expect(entry.description, `no description for ${entry.scope}`).toBeTruthy();
      expect(entry.description).not.toBe(entry.scope);
    }
    // documents:write was registered by the app but not requested here.
    expect(JSON.stringify(consent.scopes)).not.toContain('documents:write');

    // ── 2. POST /oauth/authorize/decision — the human approves ──────────────
    const { code, state, redirectTo } = await h.grantCode({
      clientId: app.client_id,
      scope: GRANTED_SCOPE_STRING,
      state: STATE,
      codeChallenge,
    });
    expect(redirectTo.startsWith(`${REDIRECT_URI}?`)).toBe(true);
    expect(code).toMatch(/^ship_ac_/);
    // state must come back byte-identical or the client cannot detect CSRF.
    expect(state).toBe(STATE);
    expect(new URL(redirectTo).searchParams.get('error')).toBeNull();

    // ── 3. POST /oauth/token — the client redeems the code ──────────────────
    const tokenRes = await h.exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: app.client_id,
      redirect_uri: REDIRECT_URI,
    });
    expect(tokenRes.status(), await tokenRes.text()).toBe(200);
    // RFC 6749 §5.1 — a cached token response is a leaked token response.
    expect(tokenRes.headers()['cache-control']).toContain('no-store');

    const tokens = await tokenRes.json();
    expect(tokens.access_token).toBeTruthy();
    expect(typeof tokens.access_token).toBe('string');
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBeGreaterThan(0);
    expect(tokens.scope).toBe(GRANTED_SCOPE_STRING);
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.refresh_token).not.toBe(tokens.access_token);

    // ── 4. GET /api/v1/me — the token is USABLE ─────────────────────────────
    // Sent from the cookie-free context: no session, Bearer only.
    const meRes = await h.client.get(`${h.apiUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(meRes.status(), await meRes.text()).toBe(200);
    const me = await meRes.json();
    expect(me.email).toBe(SEEDED_EMAIL);
    expect(me.name).toBe(SEEDED_NAME);
    expect(me.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(me.workspace_id).toMatch(/^[0-9a-f-]{36}$/);
    // The token is attributed to the app that was consented to, not to a PAT.
    expect(me.client_id).toBe(app.client_id);
  });

  test('MANDATORY NEGATIVE: a wrong code_verifier is refused with invalid_grant', async () => {
    const verifier = createVerifier();
    const codeChallenge = challengeFor(verifier);
    const app = await h.registerApp('Gate A2 Wrong Verifier');

    // Fresh code: codes are single-use, so this must not reuse another test's.
    const { code } = await h.grantCode({
      clientId: app.client_id,
      scope: GRANTED_SCOPE_STRING,
      state: STATE,
      codeChallenge,
    });

    // A different, perfectly well-FORMED verifier. The rejection must come from
    // the S256 comparison, not from a format check — otherwise this test would
    // pass against a server that never verifies PKCE at all.
    const wrongVerifier = createVerifier();
    expect(wrongVerifier).not.toBe(verifier);
    expect(wrongVerifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);

    const res = await h.exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: wrongVerifier,
      client_id: app.client_id,
      redirect_uri: REDIRECT_URI,
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toBeTruthy();
    // No token may leak into a failure body.
    expect(body.access_token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('refresh_token');
  });

  test('an authorization code is single-use: the replay is refused', async () => {
    const verifier = createVerifier();
    const codeChallenge = challengeFor(verifier);
    const app = await h.registerApp('Gate A2 Replay');

    const { code } = await h.grantCode({
      clientId: app.client_id,
      scope: GRANTED_SCOPE_STRING,
      state: STATE,
      codeChallenge,
    });

    const exchange = () =>
      h.exchange({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: app.client_id,
        redirect_uri: REDIRECT_URI,
      });

    const first = await exchange();
    expect(first.status(), await first.text()).toBe(200);
    expect((await first.json()).access_token).toBeTruthy();

    // Byte-identical replay — the exact request an attacker with a leaked
    // redirect log would send.
    const replay = await exchange();
    expect(replay.status()).toBe(400);
    const body = await replay.json();
    expect(body.error).toBe('invalid_grant');
    expect(body.access_token).toBeUndefined();
  });

  test('a mismatched redirect_uri at the token endpoint is refused', async () => {
    const verifier = createVerifier();
    const codeChallenge = challengeFor(verifier);
    const app = await h.registerApp('Gate A2 Redirect Mismatch');

    const { code } = await h.grantCode({
      clientId: app.client_id,
      scope: GRANTED_SCOPE_STRING,
      state: STATE,
      codeChallenge,
    });

    const res = await h.exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: app.client_id,
      redirect_uri: 'https://grader.example.test/callback-elsewhere',
    });

    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  test('denial issues no code and returns access_denied with the original state', async () => {
    const verifier = createVerifier();
    const codeChallenge = challengeFor(verifier);
    const app = await h.registerApp('Gate A2 Denial');

    const res = await h.decide({
      clientId: app.client_id,
      scope: GRANTED_SCOPE_STRING,
      state: STATE,
      codeChallenge,
      approve: false,
    });

    expect(res.status(), await res.text()).toBe(200);
    const redirectTo: string = (await res.json()).redirect_to;
    const url = new URL(redirectTo);

    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe(STATE);
    // The whole point of a denial: nothing redeemable comes back.
    expect(url.searchParams.get('code')).toBeNull();
    expect(redirectTo).not.toContain('ship_ac_');
  });

  test('scope escalation beyond the app registration is refused with invalid_scope', async () => {
    const codeChallenge = challengeFor(createVerifier());
    // Registered for reads only; asking for documents:write is an escalation.
    const app = await h.registerApp('Gate A2 Escalation', ['documents:read', 'issues:read']);
    const escalated = 'documents:read documents:write';

    const authorizeRes = await h.authorize({
      clientId: app.client_id,
      scope: escalated,
      state: STATE,
      codeChallenge,
    });
    expect(authorizeRes.status()).toBe(400);
    const authorizeBody = await authorizeRes.json();
    expect(authorizeBody.error).toBe('invalid_scope');
    expect(authorizeBody.error_description).toContain('documents:write');

    // The decision endpoint must re-validate rather than trust the parameters
    // the consent UI echoes back — a user editing the POST body must not be
    // able to mint a code for scopes the app never registered.
    const decisionRes = await h.decide({
      clientId: app.client_id,
      scope: escalated,
      state: STATE,
      codeChallenge,
      approve: true,
    });
    expect(decisionRes.status()).toBe(400);
    const decisionBody = await decisionRes.json();
    expect(decisionBody.error).toBe('invalid_scope');
    expect(decisionBody.redirect_to).toBeUndefined();
  });

  test('the issued token carries ONLY the granted scopes', async () => {
    const verifier = createVerifier();
    const codeChallenge = challengeFor(verifier);
    // App may do documents:write; the user grants only reads.
    const app = await h.registerApp('Gate A2 Granted Scopes Only');
    expect(app.requested_scopes).toContain('documents:write');

    const { code } = await h.grantCode({
      clientId: app.client_id,
      scope: GRANTED_SCOPE_STRING,
      state: STATE,
      codeChallenge,
    });

    const tokenRes = await h.exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: app.client_id,
      redirect_uri: REDIRECT_URI,
    });
    expect(tokenRes.status(), await tokenRes.text()).toBe(200);
    const { access_token, scope } = await tokenRes.json();
    expect(scope.split(' ').sort()).toEqual([...GRANTED_SCOPES].sort());

    const meRes = await h.client.get(`${h.apiUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(meRes.status(), await meRes.text()).toBe(200);
    const me = await meRes.json();
    expect([...me.scopes].sort()).toEqual([...GRANTED_SCOPES].sort());
    expect(me.scopes).not.toContain('documents:write');

    // And the withheld scope is actually enforced, not merely absent from a
    // list. A scope array the gate ignores is decoration.
    const writeRes = await h.client.post(`${h.apiUrl}/api/v1/documents`, {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { title: 'Should never be created' },
    });
    expect(writeRes.status()).toBe(403);
    expect(JSON.stringify(await writeRes.json())).toContain('documents:write');
  });
});
