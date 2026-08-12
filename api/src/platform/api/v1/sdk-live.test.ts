/**
 * @ship/sdk against a REAL running Ship server (MVP hard gate A8).
 *
 * The graded claim is narrow and physical:
 *
 *   "SDK skeleton exists in a pnpm workspace package; `new ShipClient({ token }).me()`
 *    against a running server returns the typed authenticated user."
 *
 * Every other SDK test (sdk/src/*.test.ts) injects a fake `fetch`. Those prove
 * the client's LOGIC — retry policy, cursor termination, error translation —
 * but they cannot prove the client and the server agree, because the server is
 * not there. A fake fetch will happily confirm any URL the client invents.
 *
 * This file removes the fake. It boots the real Express app on an ephemeral
 * port, mints a real OAuth access token in real Postgres, and drives the real
 * `ShipClient` over real HTTP with the platform's own global fetch. What is
 * under test here is the SEAM: URL construction, bearer header, JSON envelope,
 * cursor round-trip, and the public error envelope surviving translation into
 * the SDK's typed error union.
 *
 * Why this file lives in @ship/api and not @ship/sdk: the server and the test
 * database wiring are here. Putting it in the SDK package would mean either
 * duplicating that wiring or giving a zero-dependency client package a
 * dependency on Express and pg — which would defeat the point of the SDK.
 *
 * The SDK is imported from its BUILD OUTPUT (../../../../../sdk/dist/index.js),
 * not from sdk/src. That is forced, not preferred: @ship/api sets
 * `rootDir: ./src`, so pulling sdk/*.ts into this program makes `tsc` fail with
 * TS6059 ("not under rootDir") for every SDK source file — a program-level
 * error no local suppression can silence. Importing the emitted `.d.ts` is
 * clean instead, because declaration files are never emitted and so are never
 * constrained by rootDir. The consequence worth knowing: this gate requires
 * `pnpm --filter @ship/sdk build` to have run, and it exercises the artifact a
 * consumer would actually install — the stronger claim for a published client.
 *
 * Isolation: every row created here is owned by a per-test workspace and
 * removed by CASCADE in afterAll — no truncation (the agent_* convention, same
 * as middleware/authn.test.ts, whose fixture idiom this copies).
 *
 * Run it alone:
 *   pnpm --filter @ship/sdk build
 *   pnpm --filter @ship/api exec vitest run src/platform/api/v1/sdk-live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import {
  ShipClient,
  ShipError,
  type ShipDocument,
  type ShipErrorKind,
  type ShipUser,
} from '../../../../../sdk/dist/index.js';

/**
 * /me returns two fields the SDK's ShipUser does not model (they are token
 * facts, not user facts). Declared as an extension rather than asserted with
 * `any` so the extra fields are still type-checked.
 */
interface LiveMeResponse extends ShipUser {
  client_id: string | null;
  scopes: string[];
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

let server: Server;
let baseUrl: string;

let workspaceId: string;
let userId: string;
let userEmail: string;
let appId: string;
let clientId: string;

let accessToken: string;
let issuesOnlyToken: string;
let client: ShipClient;

let tokenSeq = 0;

/** Mint a real OAuth access token row — same idiom as middleware/authn.test.ts. */
async function mintToken(scopes: string[]): Promise<string> {
  const raw = `ship_${crypto.randomBytes(32).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix,
                             expires_at, revoked_at, oauth_app_id, scopes)
     VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6,$7)`,
    [userId, workspaceId, `sdk-live-${tokenSeq++}`, sha(raw), raw.slice(0, 8), appId, scopes]
  );
  return raw;
}

/** Await a rejection and hand back the typed error, or fail loudly. */
async function captureShipError(run: () => Promise<unknown>): Promise<ShipError> {
  try {
    await run();
  } catch (err) {
    if (ShipError.is(err)) return err;
    throw err;
  }
  throw new Error('Expected the SDK call to reject with a ShipError, but it resolved.');
}

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('SDK Live Gate') RETURNING id`);
  workspaceId = ws.rows[0].id;

  userEmail = `sdk-live-${crypto.randomBytes(4).toString('hex')}@ship.local`;
  const user = await pool.query(
    `INSERT INTO users (email, name) VALUES ($1,'SDK Live Tester') RETURNING id`,
    [userEmail]
  );
  userId = user.rows[0].id;

  clientId = `ship_app_${crypto.randomBytes(8).toString('hex')}`;
  const app = await pool.query(
    `INSERT INTO oauth_apps (workspace_id, owner_user_id, name, client_id,
                             client_secret_hash, client_secret_prefix, redirect_uris, requested_scopes)
     VALUES ($1,$2,'SDK Live Test App',$3,$4,'ship_sec',ARRAY['https://example.test/cb'],
             ARRAY['documents:read','documents:write','issues:read'])
     RETURNING id`,
    [workspaceId, userId, clientId, sha('secret')]
  );
  appId = app.rows[0].id;

  accessToken = await mintToken(['documents:read', 'documents:write', 'issues:read']);
  // The insufficient-scope probe: can read issues, cannot touch documents.
  issuesOnlyToken = await mintToken(['issues:read']);

  // Port 0 = "whatever is free". Never hardcode: parallel work on this repo
  // must not collide on a port, and a busy port would fail this gate for a
  // reason that has nothing to do with the SDK.
  await new Promise<void>((resolve, reject) => {
    const listening = createApp().listen(0, '127.0.0.1', () => resolve());
    listening.once('error', reject);
    server = listening;
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  // No `fetch` option: this client uses the platform's own global fetch, over
  // a real socket, to a real server. That absence is the point of the file.
  client = new ShipClient({ token: accessToken, baseUrl });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  // Workspace CASCADE removes documents, api_tokens and oauth_apps; users are
  // global (workspaces do not own them), so this suite deletes its own user.
  if (workspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
});

describe('MVP gate A8 — new ShipClient({ token }).me() against a running server', () => {
  it('returns the typed authenticated user', async () => {
    // The annotation is load-bearing, not decoration: if ShipUser or the /me
    // handler drift apart in a way that changes the field set, this line stops
    // compiling. The gate is a TYPED user, not merely a 200.
    const me: ShipUser = await client.me();

    expect(me.id).toBe(userId);
    expect(me.email).toBe(userEmail);
    expect(me.workspace_id).toBe(workspaceId);
    expect(me.name).toBe('SDK Live Tester');

    // The token facts /me also reports, checked against what we actually minted.
    const live = me as LiveMeResponse;
    expect(live.client_id).toBe(clientId);
    expect(live.scopes).toContain('documents:read');
    expect(live.scopes).toContain('documents:write');
    expect(live.scopes).toContain('issues:read');
    expect(live.scopes).not.toContain('webhooks:manage');
  });

  it('reaches the server over real HTTP, not a stub', async () => {
    // A client pointed at the same origin with no route mounted would fail
    // differently; this asserts the base URL the SDK composed is the one the
    // server is actually listening on.
    expect(client.baseUrl).toBe(baseUrl);
    const probe = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(probe.status).toBe(200);
    expect(probe.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('resource round-trip through the SDK (create → get → list)', () => {
  it('creates a document and reads the same row back', async () => {
    const created: ShipDocument = await client.documents.create({
      title: 'SDK live round-trip',
      document_type: 'wiki',
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.title).toBe('SDK live round-trip');
    expect(created.document_type).toBe('wiki');
    expect(typeof created.created_at).toBe('string');
    expect(typeof created.updated_at).toBe('string');

    // GET by id — proves path-parameter substitution against a real route.
    const fetched: ShipDocument = await client.documents.get(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe(created.title);
    expect(fetched.document_type).toBe(created.document_type);

    // …and that the row is genuinely in Postgres, in OUR workspace, rather
    // than something the server echoed back.
    const row = await pool.query(
      'SELECT id, workspace_id, created_by FROM documents WHERE id = $1',
      [created.id]
    );
    expect(row.rows[0].workspace_id).toBe(workspaceId);
    expect(row.rows[0].created_by).toBe(userId);

    // LIST — proves the page envelope parses and the new row is in it.
    const page = await client.documents.list({ limit: 100 });
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.data.map((d) => d.id)).toContain(created.id);
  });
});

describe('async-iterator pagination against real rows', () => {
  const seeded: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 7; i++) {
      const doc = await client.documents.create({
        title: `SDK live page item ${i}`,
        document_type: 'wiki',
      });
      seeded.push(doc.id);
    }
  });

  it('walks every document across multiple pages with no repeats', async () => {
    // limit: 3 over 7+ rows forces at least three server round-trips, so this
    // exercises the cursor rather than fitting in one page by accident.
    const firstPage = await client.documents.list({ limit: 3 });
    expect(firstPage.data).toHaveLength(3);
    expect(typeof firstPage.next_cursor).toBe('string');
    expect(firstPage.next_cursor).not.toBe('');

    const walked: string[] = [];
    for await (const doc of client.documents.iterate({ limit: 3 })) {
      walked.push(doc.id);
      // The consumer must never be handed a cursor. If `iterate` ever yielded
      // the page envelope instead of its items, this would catch it.
      expect(doc).not.toHaveProperty('next_cursor');
      expect(doc).not.toHaveProperty('data');
      expect(typeof doc.title).toBe('string');
      // Runaway guard: a cursor bug turns this loop infinite.
      expect(walked.length).toBeLessThan(500);
    }

    expect(new Set(walked).size).toBe(walked.length);
    for (const id of seeded) expect(walked).toContain(id);
    expect(walked.length).toBeGreaterThanOrEqual(seeded.length);
  });
});

describe('typed error union against real server failures', () => {
  it('maps a bad token to kind "auth"', async () => {
    const rogue = new ShipClient({ token: 'ship_this_token_does_not_exist', baseUrl });
    const err = await captureShipError(() => rogue.me());

    expect(err).toBeInstanceOf(ShipError);
    expect(err.kind).toBe<ShipErrorKind>('auth');
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
    expect(err.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps a syntactically valid but unknown uuid to kind "not_found"', async () => {
    const err = await captureShipError(() => client.documents.get(crypto.randomUUID()));

    expect(err.kind).toBe<ShipErrorKind>('not_found');
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    expect(err.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps insufficient scope to kind "auth" and names the missing scope', async () => {
    const starved = new ShipClient({ token: issuesOnlyToken, baseUrl });
    const err = await captureShipError(() => starved.documents.list());

    // 401 and 403 collapse to `auth` by design; the actionable distinction
    // (refresh vs. request more scope) rides in `code`, verbatim from the server.
    expect(err.kind).toBe<ShipErrorKind>('auth');
    expect(err.status).toBe(403);
    expect(err.code).toBe('forbidden');
    expect(err.message).toContain('documents:read');
    expect(err.details).toEqual({ missing_scope: 'documents:read' });

    // The union is closed: adding a kind without handling it stops this
    // compiling, which is the whole reason `kind` exists apart from `code`.
    const label = ((kind: ShipErrorKind): string => {
      switch (kind) {
        case 'auth':
          return 'reauthenticate';
        case 'not_found':
          return 'gone';
        case 'validation':
          return 'fix the request';
        case 'rate_limit':
          return 'back off';
        case 'server':
          return 'ours to fix';
        default: {
          const exhaustive: never = kind;
          return exhaustive;
        }
      }
    })(err.kind);
    expect(label).toBe('reauthenticate');
  });

  it('rejects a malformed id as kind "validation", not "not_found"', async () => {
    const err = await captureShipError(() => client.documents.get('not-a-uuid'));

    expect(err.kind).toBe<ShipErrorKind>('validation');
    expect(err.status).toBe(400);
    expect(err.code).toBe('validation_failed');
  });
});

describe('the public error envelope survives the SDK boundary', () => {
  it('exposes the server’s own request_id, per request', async () => {
    // A pass-through wrapper: real global fetch, real socket — it only reads
    // the response header on the way past so the header the SERVER sent can be
    // compared against the id the SDK surfaced from the body.
    const seenRequestIds: string[] = [];
    const observing = new ShipClient({
      token: accessToken,
      baseUrl,
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        const header = res.headers.get('x-request-id');
        if (header) seenRequestIds.push(header);
        return res;
      },
    });

    const first = await captureShipError(() => observing.documents.get(crypto.randomUUID()));
    const second = await captureShipError(() => observing.documents.get(crypto.randomUUID()));

    expect(seenRequestIds).toHaveLength(2);
    // The correlation ID the platform promises end-to-end: what the server put
    // in the X-Request-Id header is exactly what a consumer can read off the
    // caught error and paste into a support ticket.
    expect(first.requestId).toBe(seenRequestIds[0]);
    expect(second.requestId).toBe(seenRequestIds[1]);

    // Per-request, not a constant the SDK invented.
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
