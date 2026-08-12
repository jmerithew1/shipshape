/**
 * queryAuditLog — the portal's read path, against real Postgres.
 *
 * The point of these tests is the CURSOR: pages must tile the result set with
 * no gaps and no repeats, including across rows that share a timestamp (which
 * a naive `occurred_at < $1` cursor drops or duplicates).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../db/client.js';
import { queryAuditLog } from './service.js';

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let workspaceId: string;
let otherWorkspaceId: string;
let userId: string;

const CLIENT_A = `client_a_${runId}`;
const CLIENT_B = `client_b_${runId}`;

async function insertEntry(opts: {
  workspace: string;
  clientId: string | null;
  occurredAt: string;
  status?: number;
  route?: string;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO public_audit_log
       (request_id, occurred_at, client_id, user_id, workspace_id,
        method, route, scope_used, status, latency_ms)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'GET', $5, 'documents:read', $6, 7)
     RETURNING id`,
    [
      opts.occurredAt,
      opts.clientId,
      userId,
      opts.workspace,
      opts.route ?? '/api/v1/documents',
      opts.status ?? 200,
    ]
  );
  return rows[0]!.id;
}

describe('queryAuditLog', () => {
  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`Audit Service ${runId}`]
    );
    workspaceId = ws.rows[0]!.id;

    const other = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`Audit Service Other ${runId}`]
    );
    otherWorkspaceId = other.rows[0]!.id;

    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'x', 'Audit Service Test') RETURNING id`,
      [`audit-svc-${runId}@ship.local`]
    );
    userId = user.rows[0]!.id;

    // 10 entries at DISTINCT times, plus 3 sharing one timestamp so the
    // tie-break in the keyset cursor is actually exercised.
    for (let i = 0; i < 10; i++) {
      await insertEntry({
        workspace: workspaceId,
        clientId: i % 2 === 0 ? CLIENT_A : CLIENT_B,
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    for (let i = 0; i < 3; i++) {
      await insertEntry({
        workspace: workspaceId,
        clientId: CLIENT_A,
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 0)).toISOString(),
      });
    }
    // Another workspace's traffic must never appear.
    await insertEntry({
      workspace: otherWorkspaceId,
      clientId: CLIENT_A,
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 2, 0)).toISOString(),
    });
  });

  afterAll(async () => {
    // public_audit_log.workspace_id is ON DELETE CASCADE.
    for (const id of [workspaceId, otherWorkspaceId]) {
      if (id) await pool.query(`DELETE FROM workspaces WHERE id = $1`, [id]);
    }
    if (userId) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it('returns the workspace’s entries newest first, and nobody else’s', async () => {
    const page = await queryAuditLog({ workspaceId, limit: 100 });
    expect(page.data).toHaveLength(13);
    expect(page.next_cursor).toBeNull();
    expect(page.data.every((row) => row.workspace_id === workspaceId)).toBe(true);

    const times = page.data.map((row) => new Date(row.occurred_at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('pages with a stable cursor: no gaps, no repeats, across a timestamp tie', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: Awaited<ReturnType<typeof queryAuditLog>> = await queryAuditLog({
        workspaceId,
        limit: 5,
        cursor,
      });
      seen.push(...page.data.map((row) => row.id));
      cursor = page.next_cursor;
      pages++;
      expect(pages).toBeLessThan(10); // guard against a non-advancing cursor
    } while (cursor);

    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
  });

  it('filters to a single client for the per-app view', async () => {
    const page = await queryAuditLog({ workspaceId, clientId: CLIENT_B, limit: 100 });
    expect(page.data).toHaveLength(5);
    expect(page.data.every((row) => row.client_id === CLIENT_B)).toBe(true);
  });

  it('returns the full row shape the portal renders', async () => {
    const page = await queryAuditLog({ workspaceId, limit: 1 });
    const row = page.data[0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        'app_id',
        'client_id',
        'id',
        'latency_ms',
        'method',
        'occurred_at',
        'request_id',
        'route',
        'scope_used',
        'status',
        'user_id',
        'workspace_id',
      ].sort()
    );
  });

  it('clamps the page size and ignores a tampered cursor', async () => {
    const capped = await queryAuditLog({ workspaceId, limit: 9999 });
    expect(capped.data.length).toBeLessThanOrEqual(100);

    const tampered = await queryAuditLog({ workspaceId, cursor: 'not-a-cursor!!' });
    expect(tampered.data).toHaveLength(13);
  });

  it('returns an empty page for a workspace with no public traffic', async () => {
    const page = await queryAuditLog({ workspaceId: otherWorkspaceId, clientId: CLIENT_B });
    expect(page.data).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });
});
