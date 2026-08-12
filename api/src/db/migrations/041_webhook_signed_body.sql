-- 041: persist the exact signed bytes and signature header per delivery attempt
--
-- WHY THIS IS NOT "just return the payload".
-- The deliverer signs `JSON.stringify(row.payload)` and sends that exact
-- string. `payload` is JSONB, and Postgres JSONB does NOT preserve key order —
-- it normalizes. So a consumer who reads the delivery log, re-serializes the
-- payload, and verifies would compute a signature over DIFFERENT bytes than
-- were signed, and verification would fail for a delivery that was perfectly
-- valid. HMAC is over bytes, not over meaning.
--
-- Storing the signed string verbatim is what makes `ship webhooks tail` able
-- to verify a delivery it reads back from the log rather than one it caught in
-- flight — the demo path a developer on a laptop can actually run, since a
-- laptop has no publicly reachable URL.
--
-- The signing key never leaves the server; only the payload and the signature
-- it produced are exposed, and only to the app that owns the subscription.
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS signed_body TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS signature_header TEXT;
