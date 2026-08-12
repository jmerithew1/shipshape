/**
 * Authorization Code + PKCE in a single-page app (Week 6, "PlugForge").
 *
 * The whole demo is one module on purpose. What it has to prove is small and
 * specific — a public client can authenticate a human with no client secret,
 * hold the resulting token safely, and use the SDK — and a router, a state
 * library and a component tree would bury all three.
 *
 * WHY THIS FILE TALKS TO /oauth/token DIRECTLY INSTEAD OF CALLING
 * ShipClient.authorizationCodeFlow()
 * ---------------------------------------------------------------
 * That helper takes a `waitForRedirect` callback and awaits it. It fits a CLI,
 * which can spin up a loopback listener and keep its process alive, and it fits
 * a popup. It does NOT fit a full-page redirect: the moment we navigate to
 * /oauth/authorize this page is destroyed, and no promise survives that. The
 * verifier has to be parked in sessionStorage and picked up by a *fresh* page
 * load, so the exchange is a plain form POST here. The tokens still land in the
 * SDK's LocalStorageTokenStore and every API call still goes through ShipClient
 * — the SDK owns everything after the token, which is the part that matters.
 *
 * WHAT IS STORED, AND WHERE
 * -------------------------
 *   sessionStorage — the PKCE verifier and the CSRF `state`, for the seconds
 *     between "leave for the consent screen" and "come back". Session storage
 *     (not local) so they die with the tab; they are single-use and must not
 *     outlive the flow.
 *   localStorage   — the tokens, via the SDK's LocalStorageTokenStore, so a
 *     refresh of the page does not restart the login.
 *
 * Honest note on localStorage: it is readable by any script that manages to run
 * on this origin, so it is the wrong home for a token in a high-value app —
 * a same-origin backend holding an httpOnly cookie is. It is the right choice
 * for a demo whose point is the grant, and saying so is cheaper than pretending
 * otherwise.
 */
import {
  LocalStorageTokenStore,
  ShipClient,
  ShipError,
  type ShipDocument,
  type Tokens,
} from '@ship/sdk';

// ── Configuration ────────────────────────────────────────────────────────────

const CONFIG_KEY = 'ship.demo.config';
const PKCE_KEY = 'ship.demo.pkce';

interface DemoConfig {
  apiBase: string;
  clientId: string;
  scope: string;
}

const DEFAULT_CONFIG: DemoConfig = {
  apiBase: 'http://localhost:3000',
  clientId: '',
  scope: 'documents:read',
};

/**
 * The redirect URI is DERIVED, never typed by hand: it must match what is
 * registered on the OAuth app byte for byte (the server does exact string
 * comparison — see validateAuthorizeRequest — precisely so that a prefix match
 * cannot be turned into an open redirect). Deriving it removes the single most
 * common cause of a failed first run.
 */
const REDIRECT_URI = `${window.location.origin}${window.location.pathname}`;

function loadConfig(): DemoConfig {
  const params = new URLSearchParams(window.location.search);
  let stored: Partial<DemoConfig> = {};
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY);
    if (raw) stored = JSON.parse(raw) as Partial<DemoConfig>;
  } catch {
    // A hand-edited or truncated entry is treated as "no configuration".
  }
  return {
    apiBase: params.get('api') ?? stored.apiBase ?? DEFAULT_CONFIG.apiBase,
    clientId: params.get('client_id') ?? stored.clientId ?? DEFAULT_CONFIG.clientId,
    scope: params.get('scope') ?? stored.scope ?? DEFAULT_CONFIG.scope,
  };
}

function saveConfig(config: DemoConfig): void {
  window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

/** Trailing slashes are load-bearing in an exact redirect_uri match. */
function trimOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

// ── PKCE (RFC 7636), in the browser, with Web Crypto ─────────────────────────

/**
 * base64url with NO padding. The `=` characters are stripped because RFC 7636
 * §4.2 defines the challenge as BASE64URL-ENCODE(...) which is explicitly
 * without padding — and Ship's server-side check
 * (/^[A-Za-z0-9\-._~]{43,128}$/) rejects `=` outright, so leaving the padding
 * on produces an `invalid_request` that looks like a mystery.
 */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  window.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * 32 random bytes → 43 base64url characters, which is the RFC's minimum
 * verifier length and comfortably above its 256-bit entropy recommendation.
 * Every character is in the unreserved set, so the verifier needs no escaping
 * anywhere in the flow.
 */
function createVerifier(): string {
  return randomBase64Url(32);
}

/** challenge = BASE64URL(SHA-256(ASCII(verifier))) — RFC 7636 §4.2, S256 only. */
async function deriveChallenge(verifier: string): Promise<string> {
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

interface PendingFlow {
  verifier: string;
  state: string;
  redirectUri: string;
}

function stashPendingFlow(flow: PendingFlow): void {
  window.sessionStorage.setItem(PKCE_KEY, JSON.stringify(flow));
}

/** Read and CLEAR the pending flow. Single use: a verifier reused across two
 *  authorizations would let one leaked code be redeemed against the other. */
function takePendingFlow(): PendingFlow | null {
  const raw = window.sessionStorage.getItem(PKCE_KEY);
  window.sessionStorage.removeItem(PKCE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingFlow>;
    if (typeof parsed.verifier !== 'string' || typeof parsed.state !== 'string') return null;
    return {
      verifier: parsed.verifier,
      state: parsed.state,
      redirectUri: parsed.redirectUri ?? REDIRECT_URI,
    };
  } catch {
    return null;
  }
}

// ── DOM ──────────────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`browser-demo: #${id} is missing from index.html`);
  return node as T;
}

const ui = {
  apiBase: el<HTMLInputElement>('api-base'),
  clientId: el<HTMLInputElement>('client-id'),
  scope: el<HTMLInputElement>('scope'),
  redirectUri: el<HTMLInputElement>('redirect-uri'),
  connect: el<HTMLButtonElement>('connect'),
  signOut: el<HTMLButtonElement>('sign-out'),
  pasteUrl: el<HTMLInputElement>('paste-url'),
  finish: el<HTMLButtonElement>('finish'),
  status: el<HTMLParagraphElement>('status'),
  documents: el<HTMLUListElement>('documents'),
  error: el<HTMLElement>('error'),
  errorKind: el<HTMLElement>('error-kind'),
  errorCode: el<HTMLElement>('error-code'),
  errorStatus: el<HTMLElement>('error-status'),
  errorRequestId: el<HTMLElement>('error-request-id'),
  errorMessage: el<HTMLElement>('error-message'),
};

function setStatus(message: string, ok = false): void {
  ui.status.textContent = message;
  ui.status.classList.toggle('ok', ok);
}

function clearError(): void {
  ui.error.style.display = 'none';
}

/**
 * The error path, rendered honestly.
 *
 * `kind` is the SDK's closed union — the thing a consumer branches on — and
 * `request_id` is the correlation id the server minted for that exact request.
 * Showing both is the difference between "something went wrong" and a line an
 * operator can paste into a support ticket and have somebody find the request.
 *
 * `request_id` is blank for /oauth/token failures and that is not a bug: RFC
 * 6749 §5.2 pins that body to {error, error_description}, so the id rides only
 * in the X-Request-Id response header — which a cross-origin page cannot read
 * unless the server exposes it. Rendering an empty value with a note beats
 * inventing one.
 */
function renderError(err: unknown): void {
  const shipError = ShipError.is(err)
    ? err
    : new ShipError({
        kind: 'server',
        code: 'unexpected_error',
        message: err instanceof Error ? err.message : String(err),
      });

  ui.errorKind.textContent = shipError.kind;
  ui.errorCode.textContent = shipError.code;
  ui.errorStatus.textContent = shipError.status === 0 ? '— (no response)' : String(shipError.status);
  ui.errorRequestId.textContent =
    shipError.requestId === '' ? '— (not carried by this endpoint)' : shipError.requestId;
  ui.errorMessage.textContent = shipError.message;
  ui.error.style.display = 'block';
  setStatus('Failed.');
}

function renderDocuments(documents: ShipDocument[]): void {
  ui.documents.replaceChildren();
  if (documents.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'No documents in this workspace yet.';
    ui.documents.append(empty);
    return;
  }
  for (const doc of documents) {
    const item = document.createElement('li');
    item.textContent = doc.title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${doc.document_type} · updated ${doc.updated_at}`;
    item.append(meta);
    ui.documents.append(item);
  }
}

// ── The flow ─────────────────────────────────────────────────────────────────

const tokenStore = new LocalStorageTokenStore();

function currentConfig(): DemoConfig {
  return {
    apiBase: trimOrigin(ui.apiBase.value) || DEFAULT_CONFIG.apiBase,
    clientId: ui.clientId.value.trim(),
    scope: ui.scope.value.trim() || DEFAULT_CONFIG.scope,
  };
}

/** Step 1 — leave for /oauth/authorize with a freshly minted PKCE pair. */
async function beginAuthorization(): Promise<void> {
  clearError();
  const config = currentConfig();
  if (!config.clientId) {
    setStatus('Enter the OAuth app’s client_id first.');
    return;
  }
  saveConfig(config);

  const verifier = createVerifier();
  const state = randomBase64Url(16);
  stashPendingFlow({ verifier, state, redirectUri: REDIRECT_URI });

  const authorizeUrl = new URL(`${config.apiBase}/oauth/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', config.clientId);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('scope', config.scope);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', await deriveChallenge(verifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  setStatus('Redirecting to Ship for consent…');
  window.location.assign(authorizeUrl.toString());
}

interface TokenErrorBody {
  error?: string;
  error_description?: string;
  request_id?: string;
}

/** Step 2 — swap the code for tokens. This is where the verifier is spent. */
async function exchangeCode(code: string, flow: PendingFlow, config: DemoConfig): Promise<Tokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    // No client_secret. A single-page app cannot keep one — anything shipped to
    // the browser is public — and PKCE is what replaces it: only the party that
    // generated this verifier can redeem this code.
    client_id: config.clientId,
    redirect_uri: flow.redirectUri,
    code_verifier: flow.verifier,
  });

  let response: Response;
  try {
    response = await fetch(`${config.apiBase}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
  } catch (cause) {
    throw ShipError.network(cause);
  }

  const payload = (await response.json().catch(() => ({}))) as TokenErrorBody & Partial<Tokens> & {
    expires_in?: number;
  };

  if (!response.ok) {
    // The token endpoint speaks RFC 6749 §5.2, not the /api/v1 envelope, so the
    // translation into the SDK's error type happens here rather than in the SDK.
    throw new ShipError({
      kind: response.status >= 500 ? 'server' : 'auth',
      code: payload.error ?? 'oauth_error',
      message: payload.error_description ?? `Token exchange failed with status ${response.status}`,
      status: response.status,
      requestId: payload.request_id ?? response.headers.get('x-request-id') ?? '',
    });
  }

  if (typeof payload.access_token !== 'string') {
    throw new ShipError({
      kind: 'auth',
      code: 'invalid_token_response',
      message: 'Token endpoint returned no access_token',
      status: response.status,
    });
  }

  const tokens: Tokens = { access_token: payload.access_token };
  if (typeof payload.refresh_token === 'string') tokens.refresh_token = payload.refresh_token;
  if (typeof payload.expires_in === 'number') {
    tokens.expires_at = Date.now() + payload.expires_in * 1000;
  }
  return tokens;
}

/** Step 3 — the SDK takes over. Every call from here is a ShipClient call. */
async function listDocuments(config: DemoConfig): Promise<void> {
  setStatus('Loading documents…');
  const client = new ShipClient({ baseUrl: config.apiBase, tokenStore });
  const page = await client.documents.list({ limit: 25 });
  renderDocuments(page.data);
  setStatus(`Signed in. ${page.data.length} document(s) listed through @ship/sdk.`, true);
}

/**
 * Handle whatever came back on the redirect — from the address bar on load, or
 * from a URL pasted into the page. One code path for both, so the pasted route
 * cannot drift from the real one.
 */
async function handleRedirect(search: string): Promise<void> {
  clearError();
  const params = new URLSearchParams(search);
  const code = params.get('code');
  const returnedState = params.get('state');
  const oauthError = params.get('error');

  if (oauthError) {
    renderError(
      new ShipError({
        kind: 'auth',
        code: oauthError,
        message: params.get('error_description') ?? 'The authorization request was refused.',
        status: 0,
      })
    );
    return;
  }
  if (!code) {
    setStatus('That URL carries no authorization code.');
    return;
  }

  const flow = takePendingFlow();
  if (!flow) {
    setStatus('No pending authorization in this tab — start again with “Connect to Ship”.');
    return;
  }
  // CSRF: a redirect carrying somebody else's state is not our flow. Checked
  // before the code is spent, because spending it is the irreversible part.
  if (returnedState !== null && returnedState !== flow.state) {
    renderError(
      new ShipError({
        kind: 'auth',
        code: 'state_mismatch',
        message: 'The redirect returned a state that does not match the one this tab sent.',
        status: 0,
      })
    );
    return;
  }

  const config = currentConfig();
  saveConfig(config);
  setStatus('Exchanging the authorization code…');
  try {
    const tokens = await exchangeCode(code, flow, config);
    await tokenStore.set(tokens);
    // Strip the code out of the address bar: it is single-use and does not
    // belong in history, in a bookmark, or in a screenshot of the demo.
    window.history.replaceState(null, '', REDIRECT_URI);
    await listDocuments(config);
  } catch (err) {
    renderError(err);
  }
}

async function signOut(): Promise<void> {
  await tokenStore.clear();
  ui.documents.replaceChildren();
  clearError();
  setStatus('Signed out. The tokens were removed from localStorage.');
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  const config = loadConfig();
  ui.apiBase.value = config.apiBase;
  ui.clientId.value = config.clientId;
  ui.scope.value = config.scope;
  ui.redirectUri.value = REDIRECT_URI;

  ui.connect.addEventListener('click', () => {
    void beginAuthorization().catch(renderError);
  });
  ui.signOut.addEventListener('click', () => {
    void signOut();
  });
  ui.finish.addEventListener('click', () => {
    const pasted = ui.pasteUrl.value.trim();
    if (!pasted) {
      setStatus('Paste the full redirect URL first.');
      return;
    }
    let search: string;
    try {
      search = new URL(pasted).search;
    } catch {
      // Tolerate a bare query string, which is what people usually copy.
      search = pasted.startsWith('?') ? pasted : `?${pasted}`;
    }
    void handleRedirect(search).catch(renderError);
  });

  if (window.location.search.includes('code=') || window.location.search.includes('error=')) {
    await handleRedirect(window.location.search);
    return;
  }

  const existing = await tokenStore.get();
  if (existing) {
    try {
      await listDocuments(config);
    } catch (err) {
      // An expired or revoked token should not leave a dead session behind.
      await tokenStore.clear();
      renderError(err);
    }
    return;
  }

  setStatus('Not connected. Enter a client_id and press “Connect to Ship”.');
}

void boot().catch(renderError);
