# Pre-Search — Week 6 PlugForge

Completed 2026-08-10, before any Week-6 code. AI conversation artifact: this planning session
(three-lens scoping → cold critic → approved plan at `.claude/plans/`, mirrored in
`docs/defense-week6.md`). Design-time document; `docs/architecture.md` will be as-shipped.

## Phase 1 — Constraints

### 1.1 Scale & load expectations

- **Demo-window API rate:** graders + drill traffic ≈ single-digit req/s bursts, near-zero sustained.
  Webhook fanout: we seed the grader workspace with 2–3 subscriptions per relevant event type, so one
  `document.created` ⇒ 2–3 deliveries. Fanout ratio stated explicitly in the cost analysis.
- **In-memory deliverer headroom:** single Render instance, deliveries are outbound HTTP POSTs from a
  Postgres outbox poller. First-attempt P95 < 2 s holds comfortably at demo volume; the estimated
  knee is ~50 concurrent deliveries/s (connection-bound), two orders of magnitude above demo load.
  Past it, the Liskov queue-backed deliverer is the documented drop-in.
- **Concurrent device flows:** expect ≤3 (graders). Poll interval 5 s; `slow_down` adds +5 s per RFC
  8628 §3.5. Honored by per-device-code last-poll tracking.
- **Delivery-log growth:** a drill run writes ~5–10 rows; 20 CI runs/day ≈ 200 rows/day. Retention 30
  days (documented, with rationale in the cost analysis); audit log 90 days.

### 1.2 Budget & cost ceilings

- **LLM budget (Epic 7):** ≈ $1 for the week. Week 5 measured $0.04 total dev spend with 94% of runs
  zero-LLM; the rewire changes the *data access path*, not prompts, so token volume must not move.
  Verified by before/after LangSmith traces on an identical detector scenario.
- **CI minutes:** current `checks` job ~8–10 min. Adds: TTFE drill (<60 s), PKCE Playwright (~2–3
  min). Budget ≤15 min/PR; at ~40 PRs this stays inside the GitHub Actions free tier with margin.
  Timed on day 1 of the drill's existence and recorded.
- **SDK footprint:** <250 KB min+gz committed; enforced by a CI size check (esbuild bundle + gzip
  measure) — zero-runtime-dep hand-written client makes this trivial (est. <20 KB).
- **Runaway-webhook ceiling:** hard attempt cap of 6 per delivery (~36.5 min worst-case ladder), then
  DLQ — no infinite retries. Cost shape on Render Starter is fixed $7/mo, so runaway manifests as
  latency, not dollars; the guard is the attempt cap plus per-poll batch limit.

### 1.3 Timeline & scope reality

- **Must-ship epics:** OAuth (E1), v1 contract (E2), webhooks (E3), SDK (E4), CLI + TTFE (E6), agent
  rewire (E7). Portal (E5) is should-ship with a kill criterion: if it slips past Friday night, the
  minimum viable portal is the read-only delivery-log viewer + app registration; secret rotation and
  replay stay API-only (documented curl).
- **Must-ship integration:** CLI. Others: refresh-rotation drill, Idempotency drill, browser PKCE
  SPA, Slack (margin item, built early Saturday).
- **Hours:** ~8–10/day. Day-by-day plan in `docs/defense-week6.md`; de-scope ladder if OAuth slips:
  Tier 1 = PKCE-only with loopback-redirect CLI login; Tier 0 = existing `ship_` PATs drive the drill.

### 1.4 Security & data sensitivity

- **client_secret at rest:** SHA-256, unsalted, matching the existing `api_tokens` pattern — the
  secrets are 256-bit random values, not human passwords, so a slow KDF buys nothing (defended
  choice; bcrypt is for low-entropy input). Never recoverable: loss ⇒ rotation, which shows the new
  raw secret exactly once.
- **Token policy:** access tokens 1 h; refresh tokens 30 d, one-time-use with rotation on every
  exchange; reuse of a consumed refresh token invalidates the whole family (stolen-token detection).
- **Webhook payloads: thin.** IDs + type + minimal display fields; content fetched on demand with the
  subscriber's own scoped token. Tradeoff defended: one extra GET per event vs. never spraying
  document content at every registered URL.
- **Shown-once UX:** raw secrets exist only in the single POST (create/rotate) response, rendered in
  a one-time modal; responses carry `Cache-Control: no-store`; never logged (log middleware redacts);
  not reachable via GET, so back-button/history can't resurface them.

### 1.5 Team skill inventory

- **OAuth:** consumed (Ship is a CAIA/PIV OAuth *client* — `api/src/services/caia.ts`), never built
  the server side. Mitigation: RFC morning scheduled before E1 (6749 §4.1/§6, 7636, 8628), an
  RFC-section-keyed test matrix, and reuse of the proven one-time-consume pattern in
  `api/src/services/oauth-state.ts`.
- **Zod / zod-to-openapi:** high comfort — 17 files already use Zod; the OpenAPI registry is
  load-bearing today. Fallback if generation breaks late: last-good spec is committed at
  `docs/openapi.json` and served statically while the generator is fixed.
- **SDK design:** consumed both good (Stripe, Octokit) and bad SDKs. The consuming-side scars drive
  this week's choices: typed error union over string matching, iterators over exposed cursors,
  one-call webhook verification.

## Phase 2 — Architecture discovery

### 2.1 OAuth flow choices

- **Refresh tokens from day one** (Tuesday). Waiting would mean re-cutting the token table and SDK
  auth core mid-week — higher migration cost than building rotation into the initial schema.
- **Scope upgrades: re-consent.** No incremental consent this week; a new grant request supersedes.
  Simple, auditable, defensible.
- **Consent screen:** dedicated minimal React route inside Ship's UI, session-authenticated,
  protected by `frame-ancestors` CSP (verified/added to helmet config) + CSRF on the approve POST.
- **Device verify UX: paste the user_code into a form** (RFC 8628 permits either). Avoids codes in
  URLs (history/referrer leakage) and is one less moving part than `verification_uri_complete`.

### 2.2 Public API shape

- **Error shape exact on every route.** Extra context goes only inside `details?` — the envelope
  never varies; the fitness test asserts it on forced failure paths per route.
- **Field filtering: skipped for the week** (defended: additive later via `?fields=`; building it now
  is speculative surface with zero grader value).
- **Versioning policy:** additive-only within `/v1`; breaking changes require `/v2`; documented in
  the developer docs by Sunday.
- **Pagination: every public list endpoint paginates**, no exemptions — uniformity is what lets the
  fitness test enforce it mechanically (route metadata carries `isList`).

### 2.3 Webhook reliability

- **What is signed:** `t=<unix>.<rawBody>` HMAC-SHA256 under the subscription secret, Stripe's exact
  construction — binds payload to timestamp (anti-replay) and the `v1=` tag versions the scheme for
  future rotation.
- **Retry schedule:** 1s/4s/16s/1m/5m/30m + jitter. Tested with an injected clock (`now()` +
  `advance()`) owned by the deliverer via constructor DI — zero sleeps in tests.
- **Permanent vs transient:** 4xx permanent (dead-letter immediately) with two nuances — 408 and 429
  are transient (429 honors Retry-After); 410 Gone additionally deactivates the subscription. 5xx and
  timeouts are transient.
- **Idempotency-Key:** minted at first delivery attempt from the event id, stored on the delivery
  row, and passed through verbatim on every retry AND on manual replay. Documented subscriber
  contract: delivery is at-least-once; dedupe on the key.

### 2.4 SDK design

- **Hand-written, parity-tested.** Type quality beats generated noise; drift risk is retired by the
  manifest fitness test (SDK exports a machine-readable route manifest; CI diffs it against the spec
  in both directions).
- **Error model:** methods throw a typed `ShipError` carrying the discriminated union
  `{kind: 'auth'|'rate_limit'|'not_found'|'validation'|'server'}` — TypeScript-native try/catch with
  exhaustive switch on `kind`.
- **Pagination: both.** `iterate()` async iterators for the 95% case; `.list({cursor})` escape hatch
  for consumers who need explicit pages. Cursors stay opaque either way.
- **ITokenStore:** persists access + refresh tokens; refresh under concurrency is single-flight (one
  in-flight refresh per client instance, callers await the same promise).

### 2.5 Developer portal & self-service

- **Dog food: yes.** The portal calls `/api/v1` with a bearer token minted for the logged-in user via
  a pre-registered first-party portal app — no privileged internal escape hatch.
- **Secret rotation: immediate invalidation.** (Stripe offers a grace window for zero-downtime
  rotation at scale; at our scale immediate is simpler and the tradeoff is documented.)
- **Delivery-log scale:** server-side pagination (build-cheap); virtualized list is the rebuild-cheap
  later move, noted.
- **Payload display: redacted by default, click-to-reveal** — consistent with 1.4's thin-payload and
  leakage posture.

### 2.6 Agent-as-citizen rewire

- **Grant: Client Credentials (RFC 6749 §4.4).** The agent is first-party machine-to-machine — no
  human to consent per boot (device flow would demand one) and no browser (auth-code is wrong-shaped).
  Defended explicitly at the defense.
- **Seeding:** migration seeds the agent's OAuth app; its secret arrives via env at deploy —
  guaranteed to exist in every deployed environment, `/ready` asserts it.
- **Scopes:** `documents:read`, `issues:read`, `sprints:read` (detectors are read-heavy) plus
  `issues:write`, `sprints:write` (the two-verb executor: assign issue, remove sprint association).
  Each scope maps to a named detector/executor need — no blanket grants.
- **Both-ways CI proof:** feature flag `FLEETGRAPH_VIA_SDK`; CI runs the Part-2 suite twice (flag on
  with an injected fake SDK client implementing the same `ShipData` port; flag off with the pool as
  today).

## Phase 3 — Post-stack refinement

### 3.1 Security & failure modes

- **Deleted app owner:** apps soft-flagged `orphaned` + tokens deactivated; admin can transfer.
  Recovery story documented.
- **Deliverer crash mid-batch: at-least-once.** Outbox rows persist across crashes; anything
  in-flight is retried; subscribers dedupe on Idempotency-Key. Stated in the subscriber contract.
- **Leaked client_secret:** owner-driven rotation in the portal (immediate invalidation); the audit
  signal to alert on is a spike of `invalid_client` failures or token issuance from a novel origin —
  both greppable in the public audit trail by `client_id`.
- **CSRF:** portal → `/api/v1` calls are Bearer-authenticated (non-ambient credential — CSRF-exempt
  by the same rule as existing API tokens, `app.ts:56-64`). The consent screen is session-cookie
  authenticated and keeps `csrf-sync` protection + `frame-ancestors`.

### 3.2 Testing strategy

- **TTFE drill:** built SDK is `npm pack`-ed and installed from the tarball into a clean temp dir —
  proves package resolution (the thing a symlink fakes) while staying seconds-fast. The human drill
  follows the same tarball path in the published docs.
- **OAuth Playwright stability:** no external IdP to stub — Ship *is* the authorization server, so
  the whole flow runs against the app + CI Postgres. Cost: one headless browser session, ~2–3 CI
  minutes.
- **Retry testing:** deterministic clock injection in the deliverer; virtual time advanced
  explicitly. No sleeps, no wall-clock assertions anywhere in webhook tests.

### 3.3 Tooling & CI

- **Boundary lint rules (both):** `api/src/platform/api/v1/**` may not import from
  `api/src/routes/**`; `integrations/**` may not import from `api/src/**`. ESLint
  `no-restricted-imports` in the flat config; lint failure fails the build. Added tonight, before any
  cross-import can exist.
- **OpenAPI fitness in CI: fail the build on drift**, not warn — the spec is generated in-process so
  server-side drift is impossible; the diff that can drift is SDK↔spec, and the manifest test fails
  CI on any asymmetry, additive included.
- **+10% budget:** measured with the existing `bench/` harness (same seed volume, same instruments)
  Tuesday (MVP gate) and Saturday (final evidence), committed results. Not per-PR — the harness costs
  more than a PR should; the drill catches contract regressions per-PR instead.

### 3.4 Deployment & hosting

- **Where:** existing Render deployment (`terraform/render/`). Graders get a pre-registered read-only
  OAuth app + a dedicated grader workspace (Week-5 `demo@ship.local` pattern) — no real tenant data
  in scope.
- **Spec:** live at `/api/v1/openapi.json`, static copy committed at `docs/openapi.json`, and a Redoc
  UI at a stable URL on the deployed instance.
- **One-command grader setup:** README top section — install the committed SDK tarball, then
  `ship login --host https://<deployed-url>` (device flow). Exact commands + credentials in README.

### 3.5 Observability of API usage

- **Per-call metrics:** `public_audit_log` row per public call — timestamp, `client_id`, `user_id`,
  route, scope used, status, latency, `request_id`. Surfaced in the portal and queryable in SQL;
  `request_id` is the single correlation ID across ApiError responses, audit rows, and webhook
  delivery rows.
- **Agent-through-the-front-door proof:** a fitness test runs a detector cycle with the flag on and
  asserts audit rows exist for the agent's `client_id` covering each action; post-demo the same
  answer is one SQL query (grep-equivalent) on the audit trail.
- **Idempotency visibility:** replayed deliveries share their `idempotency_key` with the original
  row and carry attempt lineage — the portal shows replay chains, so subscriber dedupe health is
  readable from the portal alone (one key, one processed side-effect, N delivery rows).
