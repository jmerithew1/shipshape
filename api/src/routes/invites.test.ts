/**
 * Invite acceptance — the existing-account takeover guard (security scan,
 * CWE-287). A pending invite token must never authenticate an EXISTING user by
 * itself; only a new account is created-and-logged-in from the token.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';

describe('POST /api/invites/:token/accept — existing-account guard', () => {
  const app = createApp();
  const runId = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const victimEmail = `invite-victim-${runId}@ship.local`;

  let targetWorkspaceId: string; // the workspace the invite is for
  let homeWorkspaceId: string; // the victim's OWN workspace (where their session lives)
  let inviterId: string;
  let victimId: string;
  let token: string;

  beforeAll(async () => {
    const tw = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `Invite Target ${runId}`,
    ]);
    targetWorkspaceId = tw.rows[0].id;
    const hw = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `Victim Home ${runId}`,
    ]);
    homeWorkspaceId = hw.rows[0].id;

    const inviter = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1,'x','Inviter') RETURNING id`,
      [`inviter-${runId}@ship.local`]
    );
    inviterId = inviter.rows[0].id;
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'admin')`,
      [targetWorkspaceId, inviterId]
    );

    // The victim ALREADY has an account, and is a member of their own workspace.
    const victim = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1,'x','Victim') RETURNING id`,
      [victimEmail]
    );
    victimId = victim.rows[0].id;
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'member')`,
      [homeWorkspaceId, victimId]
    );

    token = `invtok_${crypto.randomBytes(16).toString('hex')}`;
    await pool.query(
      `INSERT INTO workspace_invites (workspace_id, email, role, token, invited_by_user_id, expires_at)
       VALUES ($1,$2,'member',$3,$4, now() + interval '7 days')`,
      [targetWorkspaceId, victimEmail, token, inviterId]
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [[victimId, inviterId]]);
    await pool.query(`DELETE FROM workspace_invites WHERE token = $1`, [token]);
    await pool.query(`DELETE FROM workspace_memberships WHERE user_id = ANY($1::uuid[])`, [
      [victimId, inviterId],
    ]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[victimId, inviterId]]);
    await pool.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [
      [targetWorkspaceId, homeWorkspaceId],
    ]);
  });

  it('refuses to authenticate an existing user from the token alone — 401, no session, no membership', async () => {
    // The attacker holds the invite token and a CSRF token (both obtainable by
    // anyone) but NO session for the victim. csrfSynchronisedProtection needs a
    // connect.sid + token, so mirror that — the point under test is the auth
    // gate, not CSRF.
    const csrfRes = await request(app).get('/api/csrf-token');
    const csrf = csrfRes.body.token;
    const connect = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] ?? '';

    const res = await request(app)
      .post(`/api/invites/${token}/accept`)
      .set('Cookie', connect) // connect.sid for CSRF only — NOT a Ship session
      .set('x-csrf-token', csrf)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.data?.requiresLogin).toBe(true);
    // No session cookie was minted for the victim…
    const cookies = res.headers['set-cookie'] as string[] | undefined;
    expect((cookies ?? []).some((c) => c.startsWith('session_id='))).toBe(false);
    // …and no membership was created in the target workspace.
    const m = await pool.query(
      `SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
      [targetWorkspaceId, victimId]
    );
    expect(m.rows).toHaveLength(0);
  });

  it('lets the invited user join once they are authenticated as themselves', async () => {
    // The victim logs in to THEIR OWN workspace: a real session for victimId.
    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1,$2,$3, now() + interval '1 hour')`,
      [sessionId, victimId, homeWorkspaceId]
    );
    let cookie = `session_id=${sessionId}`;
    // The accept route is CSRF-guarded for authenticated callers.
    const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    const csrf = csrfRes.body.token;
    const connect = csrfRes.headers['set-cookie']?.[0]?.split(';')[0];
    if (connect) cookie = `${cookie}; ${connect}`;

    const res = await request(app)
      .post(`/api/invites/${token}/accept`)
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.joined).toBe(true);
    const m = await pool.query(
      `SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
      [targetWorkspaceId, victimId]
    );
    expect(m.rows).toHaveLength(1);
  });
});
