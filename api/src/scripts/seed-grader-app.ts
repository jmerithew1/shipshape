#!/usr/bin/env node
/**
 * Seed the pre-registered read-only OAuth app graders use (MVP gate A10).
 *
 * The assignment requires the deployed instance to ship with "at least one
 * OAuth app pre-registered with read-only scopes for graders", with the
 * credentials published in the README. Because a client secret is shown
 * exactly once and is never recoverable, this script is the ONLY moment the
 * raw secret exists — it prints it, and re-running rotates rather than
 * revealing, so the printed value is always current.
 *
 * Idempotent by client_id: re-running updates scopes/redirect URIs and issues
 * a fresh secret rather than creating a duplicate app.
 *
 *   pnpm --filter @ship/api seed:grader-app
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db/client.js';
import { registerApp, rotateAppSecret } from '../platform/oauth/service.js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env.local') });

/** Read-only by design: graders can read every resource and nothing else.
 * No documents:write, no webhooks:manage — a leaked grader credential cannot
 * mutate the demo workspace. */
const GRADER_SCOPES = ['documents:read', 'issues:read', 'sprints:read'];
const GRADER_APP_NAME = 'Grader Read-Only App';
const GRADER_REDIRECT_URIS = ['http://localhost:8976/callback', 'http://127.0.0.1:8976/callback'];

async function main(): Promise<void> {
  const workspace = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM workspaces WHERE archived_at IS NULL ORDER BY created_at ASC LIMIT 1`
  );
  if (!workspace.rows[0]) {
    console.error('No workspace exists yet. Run setup first, then re-run this script.');
    process.exitCode = 1;
    return;
  }
  const { id: workspaceId, name: workspaceName } = workspace.rows[0];

  const owner = await pool.query<{ id: string; email: string }>(
    `SELECT u.id, u.email
       FROM users u
       JOIN workspace_memberships m ON m.user_id = u.id
      WHERE m.workspace_id = $1
      ORDER BY (m.role = 'admin') DESC, u.created_at ASC
      LIMIT 1`,
    [workspaceId]
  );
  if (!owner.rows[0]) {
    console.error(`Workspace "${workspaceName}" has no members. Add one, then re-run.`);
    process.exitCode = 1;
    return;
  }

  const existing = await pool.query<{ id: string; client_id: string }>(
    `SELECT id, client_id FROM oauth_apps WHERE workspace_id = $1 AND name = $2`,
    [workspaceId, GRADER_APP_NAME]
  );

  let clientId: string;
  let clientSecret: string;

  if (existing.rows[0]) {
    // Already registered: refresh its grant surface and rotate the secret so
    // the value printed below is the one that actually works.
    await pool.query(
      `UPDATE oauth_apps
          SET requested_scopes = $2, redirect_uris = $3, active = true, orphaned = false
        WHERE id = $1`,
      [existing.rows[0].id, GRADER_SCOPES, GRADER_REDIRECT_URIS]
    );
    const rotated = await rotateAppSecret(existing.rows[0].id);
    if (!rotated) throw new Error('Rotation failed for the existing grader app');
    clientId = existing.rows[0].client_id;
    clientSecret = rotated.rawClientSecret;
    console.log('Existing grader app found — scopes refreshed and secret rotated.\n');
  } else {
    const created = await registerApp({
      workspaceId,
      ownerUserId: owner.rows[0].id,
      name: GRADER_APP_NAME,
      redirectUris: GRADER_REDIRECT_URIS,
      requestedScopes: GRADER_SCOPES,
      isFirstParty: true,
    });
    clientId = created.app.client_id;
    clientSecret = created.rawClientSecret;
    console.log('Grader app registered.\n');
  }

  console.log('─'.repeat(72));
  console.log('  GRADER OAUTH APP — read-only');
  console.log('─'.repeat(72));
  console.log(`  workspace      ${workspaceName}`);
  console.log(`  scopes         ${GRADER_SCOPES.join(' ')}`);
  console.log(`  client_id      ${clientId}`);
  console.log(`  client_secret  ${clientSecret}`);
  console.log('─'.repeat(72));
  console.log('  The secret is shown ONCE. Copy it into the README now.');
  console.log('  Re-running this script rotates it (the old value stops working).');
  console.log('─'.repeat(72));
}

main()
  .catch((err) => {
    console.error('Seeding the grader app failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
