#!/usr/bin/env node
/**
 * Register FleetGraph's own first-party OAuth application (Week 6, Epic 7).
 *
 * Week 5's agent held a raw `pg.Pool`: it saw every row, no scope constrained
 * it, and nothing recorded what it read. This script gives it an identity
 * instead — a first-party app whose credentials it presents at
 * `POST /oauth/token` using the **client-credentials grant** (RFC 6749 §4.4).
 * That grant, and not the authorization-code flow, is the correct one here for
 * a structural reason: FleetGraph boots inside a server process with no human
 * present to click a consent screen and no browser to redirect to. It is
 * machine-to-machine, first-party, and the platform enforces exactly that —
 * `handleClientCredentialsGrant` refuses any app whose `is_first_party` is
 * false, and mints a token acting as the app's owner in the app's workspace.
 *
 * Modelled on `seed-grader-app.ts` (same idempotency, rotation and printing
 * conventions); the meaningful difference is the scope set, justified below.
 *
 *   pnpm --filter @ship/api seed:agent-app
 *
 * Then export the printed pair as SHIP_AGENT_CLIENT_ID / SHIP_AGENT_CLIENT_SECRET
 * and set FLEETGRAPH_VIA_SDK=true. The secret is never recoverable: re-running
 * rotates it rather than revealing the old one.
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db/client.js';
import { registerApp, rotateAppSecret } from '../platform/oauth/service.js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env.local') });

/**
 * Least privilege, and every entry is load-bearing. The agent asks for five
 * of the platform's seven scopes; the two it does NOT ask for matter as much
 * as the five it does.
 *
 *  documents:read  The detector stage reads issues and weeks through
 *                  `GET /api/v1/documents|issues|sprints`; `documents:read`
 *                  additionally gates `GET /api/v1/me`, which the agent calls
 *                  once per credential to learn which workspace its token is
 *                  bound to (see GAP-7 in `ship-data-sdk.ts`). Without it the
 *                  agent cannot even identify itself.
 *  issues:read     Five of the six detectors (orphan intake, stale issue,
 *                  stuck review, urgent-idle, due-soon-idle) are predicates
 *                  over the issue list. This is the agent's primary read.
 *  sprints:read    The week-slip detector needs the active week and its issue
 *                  rollup; weeks are `document_type = 'sprint'` and are served
 *                  by `GET /api/v1/sprints`.
 *  issues:write    The approved-disposition executor's first verb: assigning
 *                  an issue (`assign_issue`) after a human approves the card.
 *  sprints:write   The executor's second verb: removing checked issues from a
 *                  week (`move_issues_out_of_week`) — a mutation of week
 *                  membership, which is the week's resource, not the issue's.
 *
 * Deliberately NOT requested:
 *  documents:write The agent must never author or edit user content. Its whole
 *                  autonomy boundary (FLEETGRAPH.md) is "additive, attributed,
 *                  reversible" — findings and comments, never document bodies.
 *                  Omitting the scope makes that boundary enforceable by the
 *                  platform rather than merely promised by the prompt.
 *  webhooks:manage FleetGraph is a consumer of Ship data, not a publisher of
 *                  Ship events. It subscribes to nothing and registers no
 *                  endpoints; granting this would widen the blast radius of a
 *                  leaked agent credential for zero capability.
 *
 * Honest scope note: the two write scopes are requested here but are NOT yet
 * exercised. The disposition executor still writes through the pool
 * (`api/src/routes/agent.ts`); moving it onto the SDK is the follow-on to this
 * change. They are registered now because the app's grant surface is what the
 * platform validates against at token time, and rotating an app's scope set is
 * a credential-rotation event — cheaper to get right once.
 */
const AGENT_SCOPES = [
  'documents:read',
  'issues:read',
  'sprints:read',
  'issues:write',
  'sprints:write',
];
const AGENT_APP_NAME = 'FleetGraph Agent';
/**
 * The client-credentials grant never redirects, so these are unused by the
 * agent. `oauth_apps.redirect_uris` is NOT NULL, and a localhost loopback is
 * the honest placeholder — deliberately not a public URL that might look like
 * a live consent target.
 */
const AGENT_REDIRECT_URIS = ['http://127.0.0.1:0/unused-client-credentials'];

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
    [workspaceId, AGENT_APP_NAME]
  );

  let clientId: string;
  let clientSecret: string;

  if (existing.rows[0]) {
    // Refresh the grant surface and rotate, so the printed secret is the one
    // that works. `is_first_party` is re-asserted rather than assumed: the
    // client-credentials grant is refused outright without it, and an app
    // created before that column existed would otherwise fail at token time
    // with a message that points nowhere near this script.
    await pool.query(
      `UPDATE oauth_apps
          SET requested_scopes = $2, redirect_uris = $3, active = true,
              orphaned = false, is_first_party = true
        WHERE id = $1`,
      [existing.rows[0].id, AGENT_SCOPES, AGENT_REDIRECT_URIS]
    );
    const rotated = await rotateAppSecret(existing.rows[0].id);
    if (!rotated) throw new Error('Rotation failed for the existing FleetGraph agent app');
    clientId = existing.rows[0].client_id;
    clientSecret = rotated.rawClientSecret;
    console.log('Existing FleetGraph agent app found — scopes refreshed and secret rotated.\n');
  } else {
    const created = await registerApp({
      workspaceId,
      ownerUserId: owner.rows[0].id,
      name: AGENT_APP_NAME,
      redirectUris: AGENT_REDIRECT_URIS,
      requestedScopes: AGENT_SCOPES,
      // The gate for client_credentials: the platform refuses the grant to
      // any app that is not first-party.
      isFirstParty: true,
    });
    clientId = created.app.client_id;
    clientSecret = created.rawClientSecret;
    console.log('FleetGraph agent app registered.\n');
  }

  console.log('─'.repeat(72));
  console.log('  FLEETGRAPH AGENT OAUTH APP — first-party, client credentials');
  console.log('─'.repeat(72));
  console.log(`  workspace      ${workspaceName}`);
  console.log(`  grant          client_credentials (RFC 6749 §4.4)`);
  console.log(`  scopes         ${AGENT_SCOPES.join(' ')}`);
  console.log(`  client_id      ${clientId}`);
  console.log(`  client_secret  ${clientSecret}`);
  console.log('─'.repeat(72));
  console.log('  export SHIP_AGENT_CLIENT_ID=' + clientId);
  console.log('  export SHIP_AGENT_CLIENT_SECRET=' + clientSecret);
  console.log('  export FLEETGRAPH_VIA_SDK=true');
  console.log('─'.repeat(72));
  console.log('  The secret is shown ONCE and is never recoverable.');
  console.log('  Re-running this script rotates it (the old value stops working).');
  console.log('─'.repeat(72));
}

main()
  .catch((err) => {
    console.error('Seeding the FleetGraph agent app failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
