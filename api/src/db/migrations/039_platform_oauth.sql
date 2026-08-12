-- 039: PlugForge platform — OAuth server substrate (Week 6, E1)
--
-- Design (DECISIONS.md 2026-08-10 "one bearer path"): OAuth access tokens are
-- rows in the existing api_tokens table (same sha256-hash-then-lookup path the
-- API already trusts), distinguished by oauth_app_id + scopes. Tokens with
-- oauth_app_id set are PUBLIC-SURFACE-ONLY: the internal authMiddleware
-- rejects them (WHERE oauth_app_id IS NULL) so a scoped public token can
-- never reach unscoped internal routes.
--
-- One-time-consume semantics for authorization codes and device codes reuse
-- the oauth_state pattern: DELETE ... WHERE ... RETURNING (or status flip in
-- a single UPDATE) so a code can never be redeemed twice.

-- Registered OAuth applications (third-party or first-party).
CREATE TABLE IF NOT EXISTS oauth_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,    -- SHA-256; raw secret shown exactly once
  client_secret_prefix TEXT NOT NULL,  -- first 8 chars for identification
  redirect_uris TEXT[] NOT NULL DEFAULT '{}',
  requested_scopes TEXT[] NOT NULL DEFAULT '{}',
  is_first_party BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  orphaned BOOLEAN NOT NULL DEFAULT false,  -- owner deleted; admin can transfer
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  secret_rotated_at TIMESTAMPTZ
);

-- Authorization codes (Auth Code + PKCE). Short-lived, one-time-consume.
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL UNIQUE,
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256'
    CHECK (code_challenge_method IN ('S256')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Device Authorization Grant (RFC 8628).
CREATE TABLE IF NOT EXISTS oauth_device_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,      -- short human code, entered on /device
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,       -- set on approval
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  poll_interval_seconds INT NOT NULL DEFAULT 5,
  last_polled_at TIMESTAMPTZ,          -- slow_down enforcement
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh tokens: one-time-use with rotation. family_id ties a rotation chain
-- together; reuse of a consumed token revokes the entire family
-- (stolen-refresh-token detection).
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  family_id UUID NOT NULL,
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  consumed_at TIMESTAMPTZ,             -- set when exchanged; reuse => family kill
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OAuth access tokens ride the existing api_tokens substrate.
-- NOTE for issuers: api_tokens has UNIQUE(user_id, workspace_id, name) —
-- OAuth-issued rows must use a generated unique name (e.g. 'oauth:<client_id>:<uuid>').
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS oauth_app_id UUID REFERENCES oauth_apps(id) ON DELETE CASCADE;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS scopes TEXT[];
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS refresh_family_id UUID;

CREATE INDEX IF NOT EXISTS idx_oauth_apps_client_id ON oauth_apps(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_apps_workspace ON oauth_apps(workspace_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_device_user_code ON oauth_device_codes(user_code);
CREATE INDEX IF NOT EXISTS idx_api_tokens_oauth_app ON api_tokens(oauth_app_id) WHERE oauth_app_id IS NOT NULL;
