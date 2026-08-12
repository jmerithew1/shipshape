-- 040: PlugForge platform — webhooks, public audit trail, rate-limit buckets
--
-- ONE TABLE IS THE WHOLE WEBHOOK SYSTEM. The required retry ladder
-- (1s/4s/16s/1m/5m/30m) forces durable persistence no matter what, so the
-- persistence IS the queue: webhook_deliveries rows carry status, attempt
-- count, and next_attempt_at. The dead-letter queue is a status value, the
-- per-app delivery log is the same table, and replay re-enqueues a row while
-- keeping its original idempotency key. No broker to deploy, secure, or
-- explain — and IWebhookDeliverer keeps the queue-backed implementation a
-- drop-in when one instance stops being enough.

-- Per-app, per-event-type subscriptions.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  target_url TEXT NOT NULL,
  -- Signing secret is hashed at rest exactly like a client secret: the raw
  -- value is returned once at creation and is never recoverable.
  signing_secret_hash TEXT NOT NULL,
  signing_secret_prefix TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_id, event_type, target_url)
);

-- The outbox: queue + retry scheduler + dead-letter queue + delivery log.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  -- Minted once from the event and carried unchanged through every retry AND
  -- every manual replay, so subscribers can dedupe. This is the contract:
  -- delivery is at-least-once.
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'succeeded', 'failed', 'dead_lettered')),
  attempt_number INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_status INT,
  response_excerpt TEXT,
  latency_ms INT,
  last_error TEXT,
  -- Set when an operator replays a delivery; the replay row points at the
  -- original so the portal can show the chain.
  replay_of_id UUID REFERENCES webhook_deliveries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Public audit trail: every /api/v1 call. request_id is the correlation ID
-- shared with the ApiError body and the X-Request-Id header, so one value ties
-- a client-visible failure to its server-side record.
CREATE TABLE IF NOT EXISTS public_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  app_id UUID REFERENCES oauth_apps(id) ON DELETE SET NULL,
  client_id TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  scope_used TEXT,
  status INT NOT NULL,
  latency_ms INT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_subs_app ON webhook_subscriptions(app_id);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_event ON webhook_subscriptions(event_type) WHERE active;
-- The poller's hot path: "what is due?"
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries(next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub ON webhook_deliveries(subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_idem ON webhook_deliveries(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_public_audit_client ON public_audit_log(client_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_audit_workspace ON public_audit_log(workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_audit_request ON public_audit_log(request_id);
