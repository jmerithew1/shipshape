# Week 6 Architecture Defense — PlugForge (Ship as a Platform)

**Defense: Monday 2026-08-11, 1:00 PM CT.** Status: forward-looking plan — nothing below is claimed
as built. Shipped-vs-planned discipline: every claim this week lands with a file:line or stays
labeled *designed, not yet wired*.

## 1. What we're building, in one paragraph

Ship (Weeks 1–5: collaborative doc/project platform + the FleetGraph project-intelligence agent)
gains the surfaces a third-party developer needs: an OAuth 2.0 authorization server (Authorization
Code + PKCE for web, Device Grant for CLI, refresh rotation with family invalidation), a versioned
public API at `/api/v1/` with scoped bearer auth, one error shape, cursor pagination, token-bucket
rate limits and a public audit trail; HMAC-signed webhooks with retries, DLQ and replay; a typed
`@ship/sdk`; a developer portal that eats the dog food; and a CLI that is the demo. The week's
architectural payoff: FleetGraph stops being a privileged insider with a DB pool and becomes a
platform citizen — an OAuth app consuming the same public API as any stranger, with the same
scopes, rate limits, and audit trail. The rubric moment is the Time-to-First-Event drill: clean
machine → `pnpm install` the SDK → `ship login` → create a document → verified signed webhook in
the terminal, ≤30 min human, <60 s in CI on every PR.

## 2. Named components (each with owner-file and one-line responsibility)

| Component | Lives at (planned) | Responsibility | In/Out |
|---|---|---|---|
| **OAuthCore** | `api/src/platform/oauth/` | Issue/verify all three grants; consent; refresh rotation + family kill | HTTP: /oauth/authorize, /oauth/token, /oauth/device/* → tokens |
| **ScopeRegistry** | `api/src/platform/scopes/registry.ts` | Scopes-as-data; `require(scope)` middleware factory | scope strings → allow / 403 naming the missing scope |
| **TokenGate** | `api/src/platform/api/v1/middleware/authn.ts` | Bearer validation on every v1 route; populates app/user/scopes | Authorization header → req context / 401 (distinct expired code) |
| **RateKeeper** | `api/src/platform/ratelimit/` | Per-app + per-token token buckets; X-RateLimit-* on every response | req identity → allow / 429 + Retry-After |
| **AuditTrail** | `api/src/platform/audit/` | One row per public call: who, what, scope, status, latency, request_id | req/res → `public_audit_log` |
| **ApiError envelope** | `api/src/platform/api/v1/errors.ts` | `{code, message, details?, request_id}` on every public failure | any thrown error → one shape (fitness-tested) |
| **V1 Router + RouteFactory** | `api/src/platform/api/v1/` | Thin public handlers (own SQL); registers OpenAPI metadata + Express handler in ONE call | HTTP → domain reads/writes; metadata → spec |
| **SpecGen** | `api/src/platform/openapi/` | OpenAPI 3.1 generated in-process from route metadata; never hand-written | route registry → `/api/v1/openapi.json` + `docs/openapi.json` |
| **EventRegistry** | `shared/src/platform/events.ts` | 8 event types as data, one Zod schema each | domain writes → typed events |
| **ShipBus (IEventBus)** | `api/src/platform/webhooks/bus.ts` | Domain-layer publish at write chokepoints; in-process must-ship; queue-backed Liskov drop-in | events → outbox |
| **Outbox/Deliverer** | `api/src/platform/webhooks/deliverer.ts` | `webhook_deliveries` table IS queue + retry ladder + DLQ + log; injected clock | outbox rows → signed POSTs → per-app delivery log |
| **Signer** | `api/src/platform/webhooks/signature.ts` | Stripe-style `Ship-Signature: t=<unix>,v1=<hmac>`; 5-min tolerance | payload+secret → header; header+payload+secret → boolean |
| **TailRelay** | `api/src/platform/webhooks/relay.ts` | Stripe-CLI-style stream: raw delivery (headers+body verbatim) to the CLI; verification stays client-side | deliveries → SSE/long-poll stream |
| **@ship/sdk** | `sdk/` | Typed resource clients + auth helpers + iterator pagination + `verifyWebhook` + error union + route manifest | spec-shaped calls; manifest → parity fitness test |
| **ship CLI** | `integrations/cli/` | `login` (device), `docs ls/get/create`, `webhooks tail`; imports ONLY @ship/sdk | terminal → SDK → public API |
| **DevPortal** | `web/src/pages/DevPortal*` | Apps, secrets (shown-once + rotate), subscriptions, delivery log, replay — via public API only | browser → /api/v1 |
| **FleetGraph (rewired)** | existing `api/src/fleetgraph/` + `ShipData` port | Detectors swap injected pg Pool for injected SDK client behind `FLEETGRAPH_VIA_SDK` | events/cron → SDK → /api/v1 → findings |

## 3. Coordination — the two request paths

**Public API request:** `TokenGate → ScopeRegistry.require(scope) → RateKeeper → handler (own SQL) →
AuditTrail` — each a separately-named middleware file, attached only on the v1 router. Internal
`/api/*` routes are untouched; the two surfaces share the database and nothing else. A lint rule
(added before any cross-import exists) fails the build if v1 imports internal handlers or if
`integrations/` imports `api/src`.

**Write → webhook:** route handler commits → domain chokepoint (`logDocumentChange` /
issue-create) publishes a typed event to ShipBus (kill-switch checked before any query, exactly
like the Week-5 FleetGraph pattern) → outbox INSERT → Deliverer polls, signs (`t=,v1=`), POSTs →
delivery row per attempt → retry ladder 1s/4s/16s/1m/5m/30m + jitter → 6 failures → DLQ (portal
replay carries the original Idempotency-Key). Slow/down subscriber never blocks the request path —
publish is an INSERT; delivery is asynchronous.

## 4. Ownership map (who is authoritative)

- Token validity: **TokenGate** (single validator — OAuth tokens resolve through the same bearer
  path as existing `ship_` API tokens; no second auth stack).
- Scope truth: **ScopeRegistry** (middleware never hardcodes scope strings).
- Spec truth: **the running code** — SpecGen derives the spec from route metadata; there is no
  hand-written spec to disagree with. The SDK proves parity against it in CI (manifest diff, both
  directions).
- Delivery state: **webhook_deliveries** rows (queue, retries, DLQ, log are views over one table).
- Event vocabulary: **EventRegistry** Zod schemas in `shared` (domain + SDK import the same types).

## 5. AI vs deterministic (the whole table)

| Concern | AI or deterministic | Why |
|---|---|---|
| Everything platform-layer (OAuth, API, webhooks, SDK, portal, drill) | **Deterministic** | Contracts must be reproducible and auditable; an LLM adds a failure surface and zero value here. The platform makes **zero** LLM calls. |
| FleetGraph triage/chat (unchanged from Week 5) | **AI (one LLM call per agent turn)** | Unstructured summarization/conversation; already breaker-wrapped, degraded-mode, injectable. The rewire changes its *data path* (SDK vs pool), not its cost shape — verified by before/after LangSmith token measurement. |

## 6. Human-approval gates

- **OAuth consent screen** — the user grants scopes; nothing is granted silently (the point of the
  protocol). Clickjacking-protected (frame-ancestors), CSRF-protected.
- **Device-flow verify** — human pastes the user_code; a headless machine cannot self-authorize.
- **DLQ replay** — a human clicks Replay in the portal; failed deliveries never self-replay
  (idempotency key preserved so the subscriber can dedupe if the human is wrong).
- **FleetGraph disposition** — unchanged Week-5 gate: two-verb allowlisted executor behind human
  approve.

## 7. State & failure modes

State lives in Postgres (tokens, codes, apps, subscriptions, outbox/deliveries, audit) — restart
loses nothing; in-flight deliveries re-poll (at-least-once, subscriber dedupes on Idempotency-Key).
Named failure modes, one line each (full paragraphs land in `docs/architecture.md`):

- **Corrupted token store (SDK side):** ITokenStore read fails → SDK throws `kind:'auth'` → CLI
  prompts re-login. Never a silent retry loop.
- **Signing secret rotated mid-flight:** in-flight deliveries signed with the old secret fail
  verification at the subscriber → 4xx → dead-letter with the rotation event visible in the audit
  trail; new deliveries sign with the new secret. Documented as intended behavior.
- **Deliverer crashes:** outbox rows persist; poller resumes on boot; at-least-once contract.
- **OpenAPI generator throws at boot:** fail fast — the server refuses to start (a platform whose
  spec cannot generate is misconfigured); CI catches it before deploy; last-good spec is committed
  at `docs/openapi.json`.
- **Anthropic down / breaker open (agent):** Week-5 degraded rule-based mode, unchanged.

## 8. Scale constraints (what breaks first)

Single Render Starter instance. First to break under growth: (1) in-process outbox poller
throughput (~50 deliveries/s knee) → the queue-backed IWebhookDeliverer drop-in exists for exactly
this; (2) in-memory token buckets reset on deploy and don't share across instances → documented
Redis-backed alternative; (3) delivery-log growth → 30-day retention + server-side pagination.
Cost shape: platform cost scales with API + webhook traffic (fixed $7/mo at demo scale); LLM cost
scales only with agent turns (~$1/week), unchanged by the rewire.

## 9. Tradeoff ledger (the defense, pre-written)

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| OAuth implementation | Hand-rolled, on existing `api_tokens`/`oauth_state` patterns | `@node-oauth/oauth2-server`, Ory Hydra, Auth0 | No library covers Device Grant (the hard part) anyway; model-callback abstractions fight our SQL-in-handler codebase; PKCE S256 is ~5 lines of crypto; assignment intent is learning the flows |
| Token architecture | OAuth tokens resolve through the SAME bearer path as existing tokens | Parallel OAuth validator | Two validators = two revocation paths, double auth-tax, drift; one gate is defensible and testable |
| Webhook infrastructure | Postgres outbox table = queue + retry + DLQ + log | Redis/BullMQ, SQS, Inngest | Retry ladder forces persistence regardless; one table discharges four requirements; zero new infra to defend; Liskov drop-in preserved via IWebhookDeliverer |
| Event bus | New ShipBus beside FleetBus | Reuse FleetBus | FleetBus *debounces and drops* intermediate events by design — correct for agent triggers, disqualifying for webhooks (a webhook system that loses events is broken) |
| v1 domain access | Thin handlers with own scoped SQL | Extract a service layer from 1.5k-line route files | The refactor eats the week and risks Part-1/2 regressions; boundary is enforced by lint + separate router instead |
| Spec | Generated 3.1 from route metadata (RouteFactory: register+mount in one call) | Hand-written spec; copying the existing side-effect-registered pattern | Hand-written specs lie within a week (doc's words); the existing pattern structurally permits route↔spec drift — the new factory makes drift impossible server-side |
| SDK | Hand-written typed client + manifest parity test | openapi-generator codegen | Generated TS is unreadable and un-defendable; parity fitness test retires the drift risk codegen would have solved |
| `webhooks tail` transport | Stripe-CLI-style relay (server delivers raw payload; CLI verifies HMAC locally) | Tunnel (ngrok) in grader docs; polling the delivery-log API | A grader's laptop isn't reachable; tunnels add a third-party dependency to the graded path; log-polling would verify a signature we just handed ourselves over the same channel — the relay preserves the real trust model (verification key never leaves the client) |
| Terraform topology | Live Render stack (`terraform/render/`) + IAM exercise on the real SSM identity | Fresh minimal ECS side-stack; reviving the inherited EB stack | Owner call: the deployment that actually serves graders is terraform-managed and already proved destroy-redeploy (Week 5, graded); the IAM exercise runs on a *real* production permission boundary (SSM secrets) rather than a theater stack; ECS-language gap documented below, not hidden |
| Agent grant | Client Credentials (RFC 6749 §4.4) | Device Grant for the agent | First-party M2M; no human present at boot to consent; device flow would hang deploys on a human |
| Rate limiting | In-memory token buckets | Redis-backed | Single-instance deploy makes in-memory *correct*, not just cheap; the interface allows the Redis swap and the doc names in-memory as must-ship |

## 10. Terraform mapping table (defense prop)

| Doc requirement (MVP #11) | Our stack | Status |
|---|---|---|
| "app container" | `render_web_service` (native Node runtime — Render builds from source; the topology is still fully IaC-described) | Mapped, gap stated: not a container image |
| "database" | `render_postgres` | Direct match |
| "networking" | Render-managed ingress/TLS + service↔DB private networking (provider-abstracted) | Mapped, gap stated: no VPC/SG resources to show |
| "IAM task role and execution role" | No Render IAM exists. The real IAM surface in this codebase is the production secrets path — `loadProductionSecrets()` (`api/src/config/ssm.ts:38-66`) reads 5 params from SSM `/ship/{env}/` when `NODE_ENV=production` (the Render deploy deliberately runs staging to skip it — `variables.tf` documents why). Exercise: terraform-managed scratch (SSM params + IAM user), AdministratorAccess → minimal `ssm:GetParameter` on the `/ship/prod/*` ARN; the API booting under the minimal policy with `NODE_ENV=production` proves "service works"; PutParameter / out-of-path reads prove deny. Before/after policy JSON, per-permission rationale. Zero blast radius on the graded deployment | Substituted with a real-code-path equivalent, openly |
| Pinned providers, clean plan, annotated plan artifact, destroy-and-redeploy | `terraform/render/versions.tf` (1.9.1), Week-5 evidence `terraform/render/out/01–14`, refreshed with Week-6 resources | Carries forward + refresh |

**Blast-radius drill prep:** one-page dependency map (`docs/defense-week6-terraform-map.md`) + mock
rounds today — a mutated plan is read cold, unaided, before the real one is.

## 11. Roadmap & phasing (each phase retires a risk)

| Day | Ships | Risk retired |
|---|---|---|
| Sun | Defense package, Pre-Search, requirements ledger; migrations, /api/v1 mount, boundary lint, ApiError + fitness skeleton, bearer throttle fix | Contract shape locked before any endpoint exists; defense survivable |
| Mon | PKCE end-to-end (+negative), Device Grant, TokenGate, ScopeRegistry, documents resource, OpenAPI 3.1 live; Epic-7 seam prototype | The two hardest correctness risks (OAuth, spec-gen) proven; rewire path proven feasible |
| Tue (MVP) | SDK skeleton `.me()`, refresh rotation, deploy + grader app, bench regression run | MVP hard gate; perf budget verified early not late |
| Wed | Webhooks end-to-end (all seven slices), relay | The signature challenge's dependency chain complete |
| Thu (Early) | Full SDK + manifest parity, CLI, TTFE drill in CI; IAM scratch exercise (no prod contact) after submission | The rubric (drill) is green and enforcing; early submission banked |
| Fri | Portal, rate limits, audit trail, Epic-7 rewire + both-ways CI, 2 drill-integrations | Dog-food + citizen proof; flake soak begins |
| Sat | Slack, browser demo, IAM/drift evidence, architecture.md, cost analysis, write-ups, 20-run soak | Evidence complete; nothing regenerable left for Sunday |
| Sun AM | Video, post, ledger sweep, submit | — |

**De-scope ladder (pre-committed):** OAuth slips → Tier 1: PKCE-only, CLI loopback login. Worst
case → Tier 0: existing `ship_` PATs drive the TTFE drill. Portal slips → read-only delivery-log
viewer + app registration. Slack slips → 4 integrations stand (CLI, 2 drills, browser demo).

## 12. Deliberately not built

Service-layer extraction (week-eating refactor, zero grader value) · message broker (single
instance; interface preserves the swap) · OAuth libraries (see ledger) · ECS side-stack (owner
call, mapping table instead) · platform-layer AI features (scope-creep named by the doc itself) ·
npm publish (documented, not required) · plugin runtime (explicit stretch, skipped) · incremental
consent · field filtering (`?fields=`) — additive later.

## 13. If we had more time

**Next week:** queue-backed deliverer live (BullMQ) + multi-instance rate limits (Redis) + portal
delivery analytics. **Next month:** `/v2` policy exercised with a real deprecation; webhook event
transformations/filtering per subscription; SDK codegen *check* (generated client diffed against
hand-written as a second parity oracle). **Next quarter:** external developer beta — the real TTFE
distribution, not the drill's.
