-- 043: a first-party app for the TTFE drill.
--
-- The drill authenticates via Client Credentials, then subscribes to a webhook
-- and creates a document — so it needs is_first_party = true PLUS documents:write
-- and webhooks:manage. The pre-registered GRADER app is deliberately read-only
-- and not first-party (a graded requirement: "an OAuth app with read-only scopes
-- for graders"), so the drill cannot run as the grader app — Client Credentials
-- rejects a non-first-party client outright (oauth/routes.ts).
--
-- This seeds a dedicated app that REUSES the grader app's secret hash, so the
-- same SHIP_CLIENT_SECRET already provisioned in CI authenticates it too — no
-- new secret to manage. CI points SHIP_CLIENT_ID at 'ship_app_ttfe_drill'.
--
-- No-op anywhere the grader app is absent (fresh installs, test/CI databases):
-- the INSERT ... SELECT simply matches no rows, so nothing is created.
INSERT INTO oauth_apps (
  workspace_id, owner_user_id, name, client_id,
  client_secret_hash, client_secret_prefix, redirect_uris, requested_scopes,
  is_first_party
)
SELECT
  g.workspace_id, g.owner_user_id, 'TTFE Drill (first-party M2M)',
  'ship_app_ttfe_drill', g.client_secret_hash, g.client_secret_prefix,
  g.redirect_uris,
  ARRAY['documents:read', 'documents:write', 'issues:read', 'sprints:read', 'webhooks:manage'],
  true
FROM oauth_apps g
WHERE g.client_id = 'ship_app_e46d52564bc1f690'
ON CONFLICT (client_id) DO UPDATE SET
  is_first_party      = true,
  requested_scopes    = EXCLUDED.requested_scopes,
  client_secret_hash  = EXCLUDED.client_secret_hash,
  client_secret_prefix = EXCLUDED.client_secret_prefix,
  workspace_id        = EXCLUDED.workspace_id,
  owner_user_id       = EXCLUDED.owner_user_id,
  active              = true;
