#!/usr/bin/env node
/**
 * Register the first-party OAuth app the TTFE drill authenticates as.
 *
 * WHY THIS EXISTS. Migration 043 mints `ship_app_ttfe_drill` by copying the
 * GRADER app's secret hash:
 *
 *     WHERE g.client_id = 'ship_app_e46d52564bc1f690'
 *
 * That client_id is a **production** value. `seed:grader-app` registers through
 * `registerApp`, which generates a RANDOM client_id, so on any database that is
 * not production the `INSERT … SELECT` matches zero rows and the drill app is
 * silently never created. The migration is a no-op everywhere it matters, and
 * the CI job that assumed otherwise failed at token exchange with an error
 * pointing nowhere near the cause.
 *
 * So CI seeds the drill app explicitly instead of inferring it from prod data.
 *
 * WHY NOT REUSE AN EXISTING APP. Neither seeded app can run the drill:
 *   - the grader app is read-only by requirement ("read-only scopes for
 *     graders"), and the drill must create a document and manage a webhook;
 *   - the FleetGraph agent app has issues:write / sprints:write but neither
 *     documents:write nor webhooks:manage.
 * The drill needs `documents:write` + `webhooks:manage` AND `is_first_party`,
 * because `handleClientCredentialsGrant` refuses the grant to third parties.
 *
 *   pnpm --filter @ship/api seed:drill-app
 *
 * Prints `client_id` and `client_secret`. The secret is shown once; re-running
 * rotates it rather than revealing the old one.
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db/client.js';
import { registerApp, rotateAppSecret } from '../platform/oauth/service.js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env.local') });

const DRILL_APP_NAME = 'TTFE Drill (first-party M2M)';

/**
 * Exactly what the five drill stages touch, and nothing else:
 *   documents:read   `/api/v1/me` is gated by it, and the drill reads back
 *   documents:write  stage 4 creates the document that raises the event
 *   webhooks:manage  stage 3 subscribes, and poll mode reads the delivery log
 * No issues/sprints scopes: the drill never touches either.
 */
const DRILL_SCOPES = ['documents:read', 'documents:write', 'webhooks:manage'];

/** Unused by client_credentials, but the column is NOT NULL. */
const DRILL_REDIRECT_URIS = ['http://127.0.0.1:0/unused'];

async function main(): Promise<void> {
  const workspace = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM workspaces WHERE archived_at IS NULL ORDER BY created_at ASC LIMIT 1`
  );
  if (!workspace.rows[0]) {
    console.error(
      'No workspace exists yet. Run `pnpm --filter @ship/api db:seed` first — a freshly ' +
        'migrated database has no workspace, because schema.sql contains no INSERTs.'
    );
    process.exitCode = 1;
    return;
  }
  const { id: workspaceId, name: workspaceName } = workspace.rows[0];

  const owner = await pool.query<{ id: string }>(
    `SELECT u.id
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
    [workspaceId, DRILL_APP_NAME]
  );

  let clientId: string;
  let clientSecret: string;

  if (existing.rows[0]) {
    // Re-assert is_first_party rather than assume it: without it the token
    // exchange fails with `unauthorized_client`, which reads like a bad secret.
    await pool.query(
      `UPDATE oauth_apps
          SET requested_scopes = $2, redirect_uris = $3, active = true,
              orphaned = false, is_first_party = true
        WHERE id = $1`,
      [existing.rows[0].id, DRILL_SCOPES, DRILL_REDIRECT_URIS]
    );
    const rotated = await rotateAppSecret(existing.rows[0].id);
    if (!rotated) throw new Error('Rotation failed for the existing TTFE drill app');
    clientId = existing.rows[0].client_id;
    clientSecret = rotated.rawClientSecret;
    console.log('Existing TTFE drill app found — scopes refreshed and secret rotated.\n');
  } else {
    const created = await registerApp({
      workspaceId,
      ownerUserId: owner.rows[0].id,
      name: DRILL_APP_NAME,
      redirectUris: DRILL_REDIRECT_URIS,
      requestedScopes: DRILL_SCOPES,
      isFirstParty: true,
    });
    clientId = created.app.client_id;
    clientSecret = created.rawClientSecret;
    console.log('TTFE drill app registered.\n');
  }

  const line = '─'.repeat(72);
  console.log(line);
  console.log('  TTFE DRILL OAUTH APP — first-party, client credentials');
  console.log(line);
  console.log(`  workspace      ${workspaceName}`);
  console.log(`  grant          client_credentials (RFC 6749 §4.4)`);
  console.log(`  scopes         ${DRILL_SCOPES.join(' ')}`);
  console.log(`  client_id      ${clientId}`);
  console.log(`  client_secret  ${clientSecret}`);
  console.log(line);
  console.log(`  export SHIP_CLIENT_ID=${clientId}`);
  console.log(`  export SHIP_CLIENT_SECRET=${clientSecret}`);
  console.log(line);
  console.log('  The secret is shown ONCE and is never recoverable.');
  console.log('  Re-running this script rotates it (the old value stops working).');
  console.log(line);
}

main()
  .catch((err) => {
    console.error('Seeding the TTFE drill app failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
