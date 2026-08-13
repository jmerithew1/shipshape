# Week 6 — Per-Epic Write-ups

Format the assignment asks for: **before → fix → after → proof**. Where an epic
is not finished, it says so rather than rounding up.

---

## E1 — OAuth 2.0 authorization server

**Before.** Ship was an OAuth *client* (`api/src/services/caia.ts` consumes an
external IdP). It had no concept of a third-party application: no client
credentials, no consent, no scoped delegation. The only programmatic access was
a personal API token with the user's full authority.

**Fix.** A hand-rolled authorization server on the token substrate the repo
already trusted — sha256-hash-then-lookup storage, and the one-time-consume
`DELETE … RETURNING` pattern from `oauth-state.ts`. Three grants:
Authorization Code + PKCE (S256 only, enforced in the route, the Zod schema, and
a DB `CHECK`), Device Authorization Grant with server-side `slow_down`, and
Client Credentials restricted to first-party apps. Refresh tokens rotate on
every exchange; replay revokes the whole family including its access tokens.

*Why hand-rolled:* no library implements the Device Grant, which the CLI
requires — the hard part was ours regardless, and PKCE verification is five
lines of `crypto`.

**After.** `/oauth/authorize`, `/oauth/authorize/decision`, `/oauth/token`,
`/oauth/device/code`, `/oauth/device/verify`. OAuth tokens resolve through the
*same* bearer validator as existing tokens — one gate, one revocation path.

**Proof.** 57 integration tests (`api/src/platform/oauth/`), including the RFC
7636 Appendix-B vector, wrong-verifier → `invalid_grant`, code replay, device
`slow_down`, and a concurrent-replay race asserting zero live credentials
survive. Plus 8 Playwright specs. **Verified on the deployed instance**: device
flow → `authorization_pending` → `slow_down` → approval → token → `/api/v1/me`.

---

## E2 — Public API contract layer

**Before.** One flat `/api/` surface, no versioning, response envelopes that
drifted between routes (`{success, data}` in older handlers, bare objects in
newer ones), and an OpenAPI spec maintained in a parallel directory that routes
never touched — so spec/route drift was structurally possible.

**Fix.** A separate `/api/v1` router sharing no middleware with the internal API.
One `ApiError` envelope `{code, message, details?, request_id}` on every public
failure. Opaque base64url keyset cursors. A route factory that registers the
OpenAPI operation **and** mounts the handler in a single call, so a route cannot
exist without a spec entry or a declared scope. Scopes live in a registry as
data; a typo'd scope is a boot failure.

**After.** 8 public operations (me, documents ×3, issues ×2, sprints ×2), an
OpenAPI 3.1 document served at `/api/v1/openapi.json` and committed at
`docs/openapi.json`, and an ESLint rule that fails the build if platform code
imports internal handlers.

**Proof.** The fitness suite enumerates the surface and asserts all four
contract properties — and it walks the **live Express stack**, not the registry,
so a hand-mounted route cannot hide from it (verified by planting one and
watching it fail). 3.1 structural validity including full `$ref` resolution.

---

## E3 — Webhooks

**Before.** No outbound webhooks of any kind. The only eventing was FleetGraph's
in-process `EventEmitter`, which debounces per workspace and **drops
intermediate events** — correct for triggering an agent, disqualifying for a
delivery guarantee.

**Fix.** An 8-type event registry with Zod schemas; an `IEventBus` published
from the domain layer at the existing write chokepoints (never from a route);
and one Postgres table that is simultaneously the queue, the retry scheduler,
the dead-letter queue, and the per-app delivery log. Stripe-style
`Ship-Signature: t=…,v1=…` HMAC. Retry ladder 1s/4s/16s/1m/5m/30m with jitter,
4xx permanent (except 408/429 transient, 410 deactivates), 6 failures → DLQ,
replay carrying the original `Idempotency-Key`.

*Why no broker:* the retry ladder forces durable persistence anyway, so the
persistence **is** the queue. `IWebhookDeliverer` keeps a queue-backed
implementation a drop-in rather than a rewrite.

**After / Proof.** Migration `040_platform_webhooks.sql` is committed and
applied. **Status: implementation landing at time of writing** — see
`docs/week6-requirements.md` for the live status of each sub-requirement rather
than trusting this paragraph.

---

## E4 — Typed SDK

**Before.** No SDK. The nearest thing was `api/src/mcp/server.ts`, which builds
MCP tools from the internal spec at runtime — useful, but not a typed package a
third party could install.

**Fix.** `@ship/sdk`: a zero-runtime-dependency workspace package with
resource-segregated clients, async-iterator pagination that hides cursors
entirely, a discriminated error union consumers can `switch` on exhaustively,
pluggable `ITokenStore`, one-call `verifyWebhook`, and single-flight token
refresh so N concurrent 401s trigger exactly one refresh.

**After.** 14.0 KB gzipped — 5.6% of the 250 KB budget (`pnpm --filter @ship/sdk size`). `SDK_ROUTE_MANIFEST` is
load-bearing rather than descriptive: `resources.ts` builds its URLs from it, so
a method cannot call an undeclared path.

**Proof.** 81 unit tests with an injected `fetch`, plus **9 live-server tests**
that boot the real app on an ephemeral port with a real OAuth token in Postgres
— `.me()` returns the typed user, create→get→list round-trips, `iterate()` walks
7 rows with no repeats, and `request_id` is byte-identical across the SDK
boundary. Now also runs in CI (it previously did not).

---

## E5 — Rate limiting, audit trail, developer portal

**Before.** One global rate limiter keyed on IP for all of `/api/`. No record of
who called what. No UI for managing applications.

**Fix.** Per-app and per-token token buckets with `X-RateLimit-*` headers; a
`public_audit_log` row per public call keyed on `request_id`; and a portal that
consumes the public API like any other client.

**After / Proof.** One finding worth recording plainly: `X-RateLimit-*` headers
were **never actually sent**. `express-rate-limit` v8 with `standardHeaders`
alone emits the draft-6 `RateLimit-*` names, while the brief names the `X-`
family verbatim — so a graded requirement was silently unmet and the SDK's
rate-limit reader was permanently null in production. Both families are now
emitted. Remaining sub-parts land with the portal slice; consult the ledger for
current status.

---

## E6 — CLI + Time-to-First-Event drill

**Before.** No CLI. No end-to-end measurement of developer experience — only
unit tests, which cannot tell you whether a stranger can actually use the thing.

**Fix.** A `ship` CLI importing only `@ship/sdk` (enforced by lint), and a drill
that walks install → login → subscribe → create → receive → verify with
per-stage timing.

**After / Proof.** Landing at time of writing. The gate is a CI run under 60 s
with 0% flake over 20 runs.

---

## E7 — The agent becomes a platform citizen

**Before.** FleetGraph held a raw `pg.Pool` (`initFleetGraph(pool)`). It saw
every row in the database, no scope constrained it, no rate limit applied, and
nothing recorded what it did. `PRESEARCH.md` said so outright: "the agent holds
a DB pool."

**Fix.** A narrow `ShipData` port with two implementations — today's SQL, and an
SDK-backed one authenticating as a first-party OAuth app via client credentials
(no human at boot to consent, no browser to redirect). Behind
`FLEETGRAPH_VIA_SDK` so the Week-5 suite passes with the flag on and off.

**After / Proof — and an honest correction.** The intended proof is audit-log
rows carrying the agent's `client_id`. An adversarial audit found that claim
overstated, and the correction is the more useful artifact:

- `FLEETGRAPH_VIA_SDK` is set in **no** environment, so the deployed agent still
  runs the Week-5 pool path. The SDK implementation exists; production does not
  execute it.
- The audit-row test never sets the flag and never calls `resolveShipData`, and
  its assertion is not time-bounded — an earlier call with the same credential
  satisfies it. It can pass without the detector making a single HTTP call.
- The agent's **write** path is still raw SQL. `issues:write` / `sprints:write`
  are registered but unexercised, so agent mutations remain unscoped and
  unaudited — precisely the gap this epic claims to close.

Demonstrated: client-credentials auth as a first-party app, correct scoping,
`documents:write` correctly absent, and SDK reads producing audit rows.
Not demonstrated: that the agent in production goes through the front door.
`docs/architecture.md` labels E7 "designed, not yet wired" — that is the
accurate description.

---

## Honest status summary

E1, E2, E4 are complete with the evidence cited above. E3, E5, E6, E7 have their
schema and contracts committed with implementations landing; the authoritative,
continuously-updated status is
[`docs/week6-requirements.md`](week6-requirements.md), not this document.
