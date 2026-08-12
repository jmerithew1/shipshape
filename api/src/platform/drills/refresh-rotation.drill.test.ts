/**
 * DRILL: refresh-token rotation and stolen-token family revocation.
 *
 * The assignment's words: "proves a stolen refresh token, when reused,
 * invalidates the entire family."
 *
 * WHY THIS IS A DRILL AND NOT A UNIT TEST
 * ---------------------------------------
 * api/src/platform/oauth/service.test.ts already proves `rotateRefreshToken`
 * returns `{ reused: true }` for a spent token, and routes.test.ts already
 * proves POST /oauth/token maps that to `invalid_grant`. Both call the code
 * in-process. Neither can answer the only question an operator actually asks
 * after a leak — "is the thief locked out, right now, over the wire?" — because
 * neither one holds an access token and tries to USE it.
 *
 * So this file boots the real Express app on an ephemeral port and does the
 * whole thing over real HTTP with the platform's own global fetch:
 *
 *   1. a legitimate authorization_code + PKCE exchange yields (A0, R1)
 *   2. an honest rotation of R1 yields (A1, R2); R1 is now spent
 *   3. the ATTACK — R1 is replayed, as a thief who copied it would
 *   4. everything dies: R1 rejected, R2 rejected, and BOTH access tokens
 *      A0 and A1 come back 401 from /api/v1/me
 *
 * Step 4 is the load-bearing one. Revoking the refresh chain but leaving the
 * minted access tokens alive would give a thief up to a full hour of authorized
 * API calls after the theft was detected — which is exactly the window family
 * revocation exists to close, and exactly the bug an in-process unit test
 * cannot see.
 *
 * The run prints a numbered transcript so this doubles as demo evidence.
 *
 * Isolation: one workspace created here, dropped by CASCADE in afterAll. No
 * TRUNCATE, no sleeps — nothing in this drill is timing-dependent.
 *
 * Run it alone:
 *   pnpm --filter @ship/api exec vitest run src/platform/drills/refresh-rotation.drill.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { pool } from '../../db/client.js';
import { deriveCodeChallenge, createAuthorizationCode, registerApp } from '../oauth/service.js';

const REDIRECT_URI = 'https://drill.example.test/callback';
const SCOPES = ['documents:read'];

/** Only the fields this drill reads. The token endpoint sends more. */
interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

let server: Server;
let baseUrl: string;

let workspaceId: string;
let userId: string;
let appId: string;
let clientId: string;

// ── Transcript ───────────────────────────────────────────────────────────────

const transcript: string[] = [];
let stepNumber = 0;

/** Record one drill step. Printed at the end so the file is demo evidence. */
function step(line: string): void {
  stepNumber += 1;
  transcript.push(`  ${String(stepNumber).padStart(2, ' ')}. ${line}`);
}

/** Credentials are secrets; the transcript shows only enough to tell them apart. */
function tag(token: string | undefined): string {
  if (!token) return '<none>';
  return `${token.slice(0, 12)}…${token.slice(-4)}`;
}

// ── HTTP helpers (real sockets, no supertest) ────────────────────────────────

async function postToken(form: Record<string, string>): Promise<{ status: number; body: TokenBody }> {
  const res = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: (await res.json()) as TokenBody };
}

/** Call the public API with a bearer token. Returns the status only. */
async function callMe(accessToken: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return res.status;
}

/**
 * Mint a fresh authorization code for this app.
 *
 * The consent half of the flow (GET /oauth/authorize, POST
 * /authorize/decision) runs behind the browser session and is covered by
 * oauth/routes.test.ts. This drill is about what happens AFTER consent, so it
 * calls the service directly for the code and then drives the exchange over
 * real HTTP — the part under test is the token endpoint, not the consent UI.
 */
async function freshCodePair(): Promise<{ code: string; verifier: string }> {
  const verifier = crypto.randomBytes(32).toString('base64url'); // 43 unreserved chars
  const code = await createAuthorizationCode({
    appId,
    userId,
    workspaceId,
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
    codeChallenge: deriveCodeChallenge(verifier),
    codeChallengeMethod: 'S256',
  });
  return { code, verifier };
}

beforeAll(async () => {
  const runId = crypto.randomBytes(4).toString('hex');

  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`W6 Refresh Rotation Drill ${runId}`]
  );
  workspaceId = ws.rows[0]!.id;

  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Rotation Drill Victim') RETURNING id`,
    [`rotation-drill-${runId}@ship.local`]
  );
  userId = user.rows[0]!.id;

  const registered = await registerApp({
    workspaceId,
    ownerUserId: userId,
    name: `Rotation Drill App ${runId}`,
    redirectUris: [REDIRECT_URI],
    requestedScopes: SCOPES,
  });
  appId = registered.app.id;
  clientId = registered.app.client_id;

  // Port 0: never hardcode. Parallel work on this repo must not collide, and a
  // busy port would fail the drill for a reason unrelated to OAuth.
  await new Promise<void>((resolve, reject) => {
    const listening = createApp().listen(0, '127.0.0.1', () => resolve());
    listening.once('error', reject);
    server = listening;
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  // Workspace CASCADE removes oauth_apps, oauth_refresh_tokens and api_tokens.
  // Users are global, so this drill deletes its own.
  if (workspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);

  if (transcript.length > 0) {
    console.log(
      ['', '── DRILL: stolen refresh token → whole family revoked ──', ...transcript, ''].join('\n')
    );
  }
});

describe('DRILL — a replayed refresh token kills the entire rotation family', () => {
  it('rotates honestly, then fails closed the instant the spent token reappears', async () => {
    // ── 1. Legitimate login: authorization_code + PKCE over real HTTP ────────
    const { code, verifier } = await freshCodePair();
    const initial = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });

    expect(initial.status).toBe(200);
    const A0 = initial.body.access_token!;
    const R1 = initial.body.refresh_token!;
    expect(typeof A0).toBe('string');
    // client_credentials issues no refresh token (RFC 6749 §4.4.3), which is
    // why this drill uses authorization_code: there must be something to steal.
    expect(typeof R1).toBe('string');
    expect(R1.startsWith('ship_rt_')).toBe(true);
    step(`login  → access A0=${tag(A0)}  refresh R1=${tag(R1)}`);

    expect(await callMe(A0)).toBe(200);
    step(`A0 calls GET /api/v1/me → 200 (the honest client is working)`);

    // ── 2. Honest rotation: R1 is spent, R2 replaces it ──────────────────────
    const rotated = await postToken({
      grant_type: 'refresh_token',
      refresh_token: R1,
      client_id: clientId,
    });
    expect(rotated.status).toBe(200);
    const A1 = rotated.body.access_token!;
    const R2 = rotated.body.refresh_token!;
    expect(A1).not.toBe(A0);
    expect(R2).not.toBe(R1);
    step(`rotate R1 → access A1=${tag(A1)}  refresh R2=${tag(R2)} (R1 now spent)`);

    expect(await callMe(A1)).toBe(200);
    // A0 is deliberately still alive here: an honest rotation does not revoke
    // the access token already in flight, or every in-progress request would
    // fail the moment a client refreshed. It is the REPLAY below that kills it.
    expect(await callMe(A0)).toBe(200);
    step(`A1 → 200, and A0 → 200 (rotation alone revokes nothing; that is correct)`);

    // Both refresh tokens really are in one family, which is the thing that
    // makes "revoke the family" a meaningful act rather than a metaphor.
    const family = await pool.query<{ family_id: string; consumed_at: Date | null }>(
      `SELECT family_id, consumed_at FROM oauth_refresh_tokens
        WHERE token_hash = ANY($1::text[])`,
      [[sha256(R1), sha256(R2)]]
    );
    expect(family.rows).toHaveLength(2);
    expect(new Set(family.rows.map((r) => r.family_id)).size).toBe(1);

    // ── 3. THE ATTACK: the thief replays R1 ─────────────────────────────────
    // The thief copied R1 out of a log, a backup, or a compromised laptop, and
    // presents it after the honest client has already rotated it.
    const attack = await postToken({
      grant_type: 'refresh_token',
      refresh_token: R1,
      client_id: clientId,
    });

    expect(attack.status).toBe(400);
    expect(attack.body.error).toBe('invalid_grant');
    expect(attack.body.access_token).toBeUndefined();
    expect(attack.body.refresh_token).toBeUndefined();
    step(`ATTACK: replay R1 → 400 invalid_grant ("${attack.body.error_description}")`);

    // ── 4. The whole family is dead, not just the replayed token ────────────
    // R2 is the token the LEGITIMATE client is holding right now. It dies too.
    const legitimateRetry = await postToken({
      grant_type: 'refresh_token',
      refresh_token: R2,
      client_id: clientId,
    });
    expect(legitimateRetry.status).toBe(400);
    expect(legitimateRetry.body.error).toBe('invalid_grant');
    expect(legitimateRetry.body.access_token).toBeUndefined();
    step(`R2 (the honest client's live token) → 400 invalid_grant`);

    // THE ASSERTION THIS DRILL EXISTS FOR. Killing the refresh chain while the
    // already-minted access tokens keep working would hand the thief up to
    // ACCESS_TOKEN_TTL_SECONDS (one hour) of authorized API calls after the
    // theft was detected. Both tokens must be dead over the wire, now.
    expect(await callMe(A0)).toBe(401);
    expect(await callMe(A1)).toBe(401);
    step(`A0 → 401 and A1 → 401 (every access token minted from the family is revoked)`);

    // And a fresh login still works — the app is not bricked, only this family.
    const recovery = await freshCodePair();
    const relogin = await postToken({
      grant_type: 'authorization_code',
      code: recovery.code,
      code_verifier: recovery.verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    expect(relogin.status).toBe(200);
    expect(await callMe(relogin.body.access_token!)).toBe(200);
    step(`re-login → 200 (recovery path intact; only the compromised family died)`);
  });

  it('records the revocation in the database, for both token kinds', async () => {
    // A second, independent family — so this case cannot be satisfied by rows
    // the previous test left behind.
    const { code, verifier } = await freshCodePair();
    const initial = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    const R1 = initial.body.refresh_token!;

    const familyRow = await pool.query<{ family_id: string }>(
      `SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = $1`,
      [sha256(R1)]
    );
    const familyId = familyRow.rows[0]!.family_id;

    await postToken({ grant_type: 'refresh_token', refresh_token: R1, client_id: clientId });
    await postToken({ grant_type: 'refresh_token', refresh_token: R1, client_id: clientId }); // replay

    const refreshTokens = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM oauth_refresh_tokens WHERE family_id = $1`,
      [familyId]
    );
    expect(refreshTokens.rows).toHaveLength(2); // R1 and its rotation R2
    expect(refreshTokens.rows.every((r) => r.revoked_at !== null)).toBe(true);

    const accessTokens = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM api_tokens WHERE refresh_family_id = $1`,
      [familyId]
    );
    expect(accessTokens.rows).toHaveLength(2); // minted at login and at rotation
    expect(accessTokens.rows.every((r) => r.revoked_at !== null)).toBe(true);

    step(
      `db check: family ${familyId.slice(0, 8)}… → ` +
        `${refreshTokens.rows.length}/${refreshTokens.rows.length} refresh tokens revoked, ` +
        `${accessTokens.rows.length}/${accessTokens.rows.length} access tokens revoked`
    );
  });

  it('locks the legitimate user out too — and that is the correct answer', async () => {
    const { code, verifier } = await freshCodePair();
    const initial = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    });
    const R1 = initial.body.refresh_token!;

    const honest = await postToken({
      grant_type: 'refresh_token',
      refresh_token: R1,
      client_id: clientId,
    });
    const A1 = honest.body.access_token!;
    const R2 = honest.body.refresh_token!;
    expect(await callMe(A1)).toBe(200);

    // The thief replays. The victim did nothing wrong and is holding (A1, R2).
    await postToken({ grant_type: 'refresh_token', refresh_token: R1, client_id: clientId });

    // WHY THE VICTIM'S LOCKOUT IS CORRECT BEHAVIOUR, NOT A BUG.
    //
    // Two parties are now presenting tokens from the same rotation chain, and
    // the server has NOTHING that distinguishes them. A refresh token is a
    // bearer credential: whoever holds the string is, by definition, the
    // client. There is no device identity, no proof of possession, no second
    // factor on this endpoint — the thief's HTTP request is byte-identical in
    // every way that matters to the victim's.
    //
    // So there are exactly two available policies:
    //
    //   fail OPEN  — keep the chain alive and let both parties continue. The
    //                thief now has an indefinitely renewable session, and the
    //                server has silently decided the attacker is the customer.
    //   fail CLOSED — kill the chain for both. The victim is logged out and
    //                must re-authenticate; the thief is logged out and, lacking
    //                the victim's credentials, cannot come back.
    //
    // Failing closed converts a silent, permanent compromise into a visible,
    // recoverable inconvenience — and the inconvenience lands on the party who
    // can actually fix it (the human who can log in again). That asymmetry is
    // the whole argument, and it is why RFC 6819 §5.2.2.3 and the OAuth 2.1
    // BCP both mandate it. The victim's 401 below is the drill PASSING.
    expect(await callMe(A1)).toBe(401);
    const victimRefresh = await postToken({
      grant_type: 'refresh_token',
      refresh_token: R2,
      client_id: clientId,
    });
    expect(victimRefresh.status).toBe(400);
    expect(victimRefresh.body.error).toBe('invalid_grant');

    step(`victim holding (A1,R2) is locked out too → fail-closed, by design`);
  });
});

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
