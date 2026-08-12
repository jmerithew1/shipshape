/**
 * Public v1 resource tests (MVP gate A4 + cursor pagination B9).
 * Real Postgres, per-test workspace, CASCADE cleanup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createV1Router } from '../router.js';
import { registerV1Routes } from './routes.js';
import { decodeCursor } from '../pagination.js';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

let workspaceId: string;
let userId: string;
let appId: string;
let readToken: string;
let writeToken: string;
let tokenSeq = 0;

async function mintToken(scopes: string[]): Promise<string> {
  const raw = `ship_${crypto.randomBytes(32).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, oauth_app_id, scopes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, workspaceId, `res-token-${tokenSeq++}`, sha(raw), raw.slice(0, 8), appId, scopes]
  );
  return raw;
}

async function seedDoc(opts: {
  type?: string;
  title: string;
  updatedAt?: string;
  properties?: Record<string, unknown>;
}): Promise<string> {
  const res = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, properties, created_by, updated_at)
     VALUES ($1, $2::document_type, $3, $4, $5, COALESCE($6::timestamptz, now()))
     RETURNING id`,
    [workspaceId, opts.type ?? 'wiki', opts.title, opts.properties ?? {}, userId, opts.updatedAt ?? null]
  );
  return res.rows[0].id;
}

const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', createV1Router(registerV1Routes));
  return a;
};

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('W6 Resources Test') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const user = await pool.query(
    `INSERT INTO users (email, name) VALUES ($1,'Resource Tester') RETURNING id`,
    [`res-${crypto.randomBytes(4).toString('hex')}@ship.local`]
  );
  userId = user.rows[0].id;
  const oapp = await pool.query(
    `INSERT INTO oauth_apps (workspace_id, owner_user_id, name, client_id, client_secret_hash,
                             client_secret_prefix, redirect_uris, requested_scopes)
     VALUES ($1,$2,'Resource App',$3,$4,'ship_sec',ARRAY['https://example.test/cb'],
             ARRAY['documents:read','documents:write','issues:read','sprints:read'])
     RETURNING id`,
    [workspaceId, userId, `ship_app_${crypto.randomBytes(8).toString('hex')}`, sha('s')]
  );
  appId = oapp.rows[0].id;

  readToken = await mintToken(['documents:read', 'issues:read', 'sprints:read']);
  writeToken = await mintToken(['documents:read', 'documents:write']);
});

afterAll(async () => {
  if (workspaceId) await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
});

describe('GET /api/v1/me', () => {
  it('returns the typed authenticated user with its scopes', async () => {
    const res = await request(app()).get('/api/v1/me').set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(userId);
    expect(res.body.workspace_id).toBe(workspaceId);
    expect(res.body.client_id).toMatch(/^ship_app_/);
    expect(res.body.scopes).toContain('documents:read');
  });
});

describe('documents resource', () => {
  it('GET list returns the {data, next_cursor} envelope', async () => {
    await seedDoc({ title: 'List me' });
    const res = await request(app()).get('/api/v1/documents').set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty('next_cursor');
    expect(res.body.data[0]).toHaveProperty('document_type');
  });

  it('POST creates a document and returns 201 with the created row', async () => {
    const res = await request(app())
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${writeToken}`)
      .send({ title: 'Created through the public API', content_text: 'hello' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Created through the public API');
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);

    const get = await request(app())
      .get(`/api/v1/documents/${res.body.id}`)
      .set('Authorization', `Bearer ${readToken}`);
    expect(get.status).toBe(200);
    expect(get.body.id).toBe(res.body.id);
  });

  it('POST requires documents:write — a read-only token gets a named 403', async () => {
    const res = await request(app())
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${readToken}`)
      .send({ title: 'Should not exist' });
    expect(res.status).toBe(403);
    expect(res.body.details).toEqual({ missing_scope: 'documents:write' });
  });

  it('rejects an invalid body with the validation envelope', async () => {
    const res = await request(app())
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${writeToken}`)
      .send({ title: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.request_id).toBeTruthy();
  });

  it('404s an unknown id in the ApiError shape', async () => {
    const res = await request(app())
      .get(`/api/v1/documents/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('filters by type and never leaks another workspace’s rows', async () => {
    await seedDoc({ title: 'An issue', type: 'issue', properties: { state: 'todo' } });
    const other = await pool.query(`INSERT INTO workspaces (name) VALUES ('Other WS') RETURNING id`);
    try {
      await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by) VALUES ($1,'wiki','Secret',$2)`,
        [other.rows[0].id, userId]
      );
      const res = await request(app())
        .get('/api/v1/documents?type=issue')
        .set('Authorization', `Bearer ${readToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.every((d: { document_type: string }) => d.document_type === 'issue')).toBe(true);

      const all = await request(app()).get('/api/v1/documents').set('Authorization', `Bearer ${readToken}`);
      expect(all.body.data.some((d: { title: string }) => d.title === 'Secret')).toBe(false);
    } finally {
      await pool.query('DELETE FROM workspaces WHERE id = $1', [other.rows[0].id]);
    }
  });
});

describe('cursor pagination (requirement B9)', () => {
  it('walks pages without repeating or skipping rows', async () => {
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('W6 Pagination') RETURNING id`);
    const pagWorkspace = ws.rows[0].id;
    const raw = `ship_${crypto.randomBytes(32).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, oauth_app_id, scopes)
       VALUES ($1,$2,'pag',$3,$4,NULL,NULL)`,
      [userId, pagWorkspace, sha(raw), raw.slice(0, 8)]
    );
    try {
      for (let i = 0; i < 7; i++) {
        await pool.query(
          `INSERT INTO documents (workspace_id, document_type, title, created_by, updated_at)
           VALUES ($1,'wiki',$2,$3, now() - ($4 || ' minutes')::interval)`,
          [pagWorkspace, `Doc ${i}`, userId, String(i)]
        );
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const url = `/api/v1/documents?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res: { status: number; body: { data: { id: string }[]; next_cursor: string | null } } =
          await request(app()).get(url).set('Authorization', `Bearer ${raw}`);
        expect(res.status).toBe(200);
        seen.push(...res.body.data.map((d) => d.id));
        cursor = res.body.next_cursor;
        if (!cursor) break;
      }

      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7); // no repeats
      expect(cursor).toBeNull(); // terminated cleanly
    } finally {
      await pool.query('DELETE FROM workspaces WHERE id = $1', [pagWorkspace]);
    }
  });

  it('rejects a tampered cursor with a validation error, never a 500', async () => {
    const res = await request(app())
      .get('/api/v1/documents?cursor=not-a-real-cursor')
      .set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
  });

  it('emits an opaque cursor that decodes to a (timestamp, id) pair', async () => {
    for (let i = 0; i < 3; i++) await seedDoc({ title: `Cursor doc ${i}` });
    const res = await request(app())
      .get('/api/v1/documents?limit=1')
      .set('Authorization', `Bearer ${readToken}`);
    expect(res.body.next_cursor).toBeTruthy();
    const decoded = decodeCursor(res.body.next_cursor);
    expect(decoded).toHaveProperty('ts');
    expect(decoded).toHaveProperty('id');
  });
});

describe('issues and sprints resources', () => {
  it('lists issues with issue-specific fields', async () => {
    await seedDoc({ title: 'Assigned issue', type: 'issue', properties: { state: 'in_progress', priority: 'high' } });
    const res = await request(app()).get('/api/v1/issues').set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(200);
    const found = res.body.data.find((i: { title: string }) => i.title === 'Assigned issue');
    expect(found).toBeTruthy();
    expect(found.priority).toBe('high');
    expect(found.state).toBe('in_progress');
  });

  it('lists sprints and enforces the sprints:read scope', async () => {
    await seedDoc({ title: 'Sprint 1', type: 'sprint', properties: { start_date: '2026-08-10' } });
    const ok = await request(app()).get('/api/v1/sprints').set('Authorization', `Bearer ${readToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.find((s: { title: string }) => s.title === 'Sprint 1').start_date).toBe('2026-08-10');

    const denied = await request(app()).get('/api/v1/sprints').set('Authorization', `Bearer ${writeToken}`);
    expect(denied.status).toBe(403);
    expect(denied.body.details).toEqual({ missing_scope: 'sprints:read' });
  });
});
