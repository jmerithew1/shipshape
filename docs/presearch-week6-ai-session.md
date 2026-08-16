# Week 6 — PlugForge: Ship Becomes a Developer Platform

> **This file is the Pre-Search reference artifact** required by the brief
> ("saved AI conversation attached as a reference artifact"). It is the verbatim
> output of the AI planning session held **2026-08-10, before any Week-6 code
> existed** — three-lens scoping, then an adversarial cold-critic pass, then the
> owner-approved plan. [`PRESEARCH-W6.md`](../PRESEARCH-W6.md) answers the three
> required phases in prose; this is the session that produced those answers.
>
> Copied into the repo 2026-08-16. It previously lived only in the local agent's
> plan directory, so `PRESEARCH-W6.md` cited an artifact a grader could not open.
> Preserved as written — where the shipped system diverged from this plan,
> `docs/architecture.md` and `DECISIONS.md` are the as-shipped truth.

## Context

GFA Week 6 (Aug 10–16, 2026) turns Ship into a platform: OAuth 2.0 server (Auth Code + PKCE, Device Grant, refresh rotation), public `/api/v1/` with scopes/ApiError/cursor pagination/rate limits/audit, HMAC-signed webhooks with retry/DLQ/replay, typed `@ship/sdk`, dev portal, CLI, Terraform/IAM evidence, and the Week-5 FleetGraph agent rewired to consume the public API as an OAuth citizen. Assignment: `C:\Users\merit\Downloads\GFA_Week_6_PlugForge.pdf` (18 pages, fully extracted this session).

**Repo: `C:\dev\shipshape`** (session cwd is the stale OneDrive placeholder — all work happens in C:\dev\shipshape). Branch `main` clean at `968b173`; zero week-6 work exists.

**Deadlines:** Architecture Defense **Mon Aug 11, 1:00 PM CT** (graders present a modified terraform plan; reading it without AI is pass/fail — auto-fail item) · MVP Tue 11:59 PM · Early Thu 11:59 PM · Final Sun 11:59 AM.

## Goal contract (owner-approved)

By Sunday Aug 16, 11:59 AM CT, **every pass/fail deliverable met with evidence** (file:line, CI runs, deployed URLs) — target 100/100 — with the Monday defense survivable without AI and the TTFE drill as the proof spine (green in CI, <60s, 0% flake over 20 runs). **Evidence rule:** no claim ships without a receipt; anything not wired is labeled "designed, not yet wired." **Defense-first today** (owner-approved): defense package + terraform rehearsal before build starts.

## Owner decisions already made (do not re-litigate)

- Goal level: 100/100, all deliverables. Defense-first today.
- **Terraform topology = the live Render stack** (`terraform/render/`), per Week-5 precedent (destroy-redeploy already graded 100/100 there). No ECS side-stack. The IAM least-privilege exercise runs on the **real AWS identity Ship prod uses for SSM Parameter Store** (a genuine live-system policy), via a zero-blast-radius duplicate identity first (critic fix #4). The ECS-language gap ("app container, task/execution role") is documented openly in the defense mapping table — flagged as residual risk, not hidden.
- **Integrations (5 of 7):** CLI (must-ship), refresh-rotation drill, Idempotency-Key dedupe drill, browser SDK demo (PKCE SPA), Slack (margin item — built before polish; if it slips we're at 4, so it goes early on Saturday).

## Lens findings (three-lens Gate 1) — load-bearing conclusions

- **Economics:** one Postgres `webhook_deliveries` outbox table = queue + retry scheduler + DLQ + delivery log (no Redis/broker — discharges four requirements with one artifact). Upgrade the existing zod-to-openapi generator in place to 3.1 (`OpenApiGeneratorV31` confirmed in installed 7.3.4) — one spec artifact feeds the 3.1 unit test, route-parity fitness test, and SDK drift test.
- **Psychology:** the terraform reading is cold-recall — today needs a one-page dependency map + 2–3 mock rounds narrating mutated plans aloud. The grader drill has two silence traps (post-approval login, tail-before-first-event) — every CLI step prints affirmative feedback and CI asserts those strings (timing-safe: assert after polling completes, never on RFC 8628 interval timing). Middleware = separately-named boring files so interview answers are the directory listing. Write-ups written while building, in James's voice.
- **Technology:** hand-roll OAuth on existing `api_tokens`/`oauth_state` patterns (no library implements Device Grant; PKCE S256 is ~5 lines of crypto). **Load-bearing:** OAuth tokens resolve through the SAME bearer path as existing tokens (`api/src/middleware/auth.ts:39-47`), and the bearer path's unthrottled per-request `last_used` UPDATE (`auth.ts:60-63`) gets the session path's 30s throttle (`auth.ts:219-225`) BEFORE any benchmark. FleetBus is disqualified as IEventBus (debounces/drops events; raw timers) — new bus runs side-by-side at the same 2 chokepoints (`routes/issues.ts:646`, `utils/document-crud.ts:76-86`), gated `WEBHOOKS_ENABLED`-checked-before-any-query exactly like `FLEETGRAPH_ENABLED` (else 4 mock-sequence suites break: iterations, projects, api-tokens, issues-history tests). NO service-layer extraction (documents.ts/issues.ts are 1.5k+ lines, 60 query sites each) — thin v1 handlers with own SQL behind the boundary lint rule. v1 document-list params designed from `fleetgraph/detectors.ts` needs (type/state/updated_before + association expansion) or Epic 7 can't express them. TTFE drill = plain Node HTTP script against CI's existing postgres:16 service — NOT Playwright/testcontainers (the flake source). `check-api-coverage.sh` needs ~30min whitelist extension for portal fetches.

## Cold-critic findings (Gate 2) → resolutions (all folded in)

1. **Clean-machine install + tail transport contradiction** → quickstart installs a committed `npm pack` tarball (`pnpm add ./ship-sdk-<ver>.tgz`); doc explicitly permits workspace package with npm-publish documented-not-required. `ship webhooks tail` = **Stripe-CLI pattern**: deliverer signs + POSTs raw payload to a Ship-hosted relay; CLI streams headers+body verbatim and verifies HMAC locally with the subscription secret. Same trust model as `stripe listen`; defended as such. Local/CI targets localhost directly.
2. **No OAuth de-scope ladder** → Tier 1: Auth Code + PKCE only, CLI uses loopback-redirect login. Tier 0: existing `ship_` PATs drive the TTFE drill (they already flow through the bearer path). Cut lines live in the schedule; OAuth starts tonight (Sunday), not Monday.
3. **Epic 7 under-specified, parked Friday** → seam prototype moved before Tuesday MVP gate: detectors' `pool` dependency becomes a `ShipData` port; flag ON injects a fake SDK client implementing the same port (existing `test-fakes.ts` pattern); integration test boots Express on an ephemeral port for real loopback. SDK grows `ShipClient.clientCredentials({client_id, client_secret})` for the seeded first-party agent app (defended as RFC 6749 §4.4 first-party M2M).
4. **IAM experiment on live prod identity** → duplicate identity with the minimal policy first; prove allow-works/deny-fails with its own creds; swap prod to it only after Thursday early submission, smoke test + instant rollback (old creds stay valid until confirmed).
5. **Parity gate had no mechanism** → SDK exports a machine-readable route manifest (each client method declares method+path+params+schema refs); fitness test diffs manifest ↔ OpenAPI spec in both directions. Scoped as Thursday work (~1 day). Also: verify helmet actually emits `frame-ancestors` for the consent screen (add if absent).

## Architecture (what gets built where)

New code lands in `api/src/platform/` (oauth, scopes, ratelimit, webhooks, audit, api/v1 router+middleware, openapi-v1 registry), `sdk/` workspace package (`@ship/sdk`, added to `pnpm-workspace.yaml`), `integrations/` (cli, slack, browser-demo — imports ONLY `@ship/sdk`, enforced by lint), portal pages in `web/src/pages/DevPortal*`. Migrations from `039_`: oauth_apps, oauth_grants/codes/device_codes, oauth_tokens (or api_tokens extension), refresh_token_families, webhook_subscriptions, webhook_deliveries, public_audit_log. Existing untouched: FleetBus, internal `/api/*` routes, session auth.

Key interfaces: `IEventBus` (publish from domain chokepoints; InProcessBus must-ship, OutboxPollerBus is the Liskov drop-in), `IWebhookDeliverer` (deterministic-clock injectable), `ScopeRegistry` (scopes-as-data: documents:read/write, issues:read/write, sprints:read/write, webhooks:manage), `ITokenStore` (memory/file/localStorage), route-factory registering OpenAPI metadata + Express handler in one call.

**Week-5 handoff refinements (owner-provided brief, folded in — no lens rerun warranted):**
- **v1 resources are views over the unified document model:** issues = `documents` rows `document_type='issue'`; sprints = week-type docs, membership via `document_associations relationship_type='sprint'`; completion = `state='done'` (never `completed_at`); `assignee_id` = users.id; staleness = `updated_at`. SDK's three resource clients are filtered views over one table — defended as "public contract stable over unified storage."
- **`sprint.started`/`sprint.completed` have no write to hook** (weeks are time-computed from `workspaces.sprint_start_date`; `properties.status` lags). Publisher = week-boundary check on the existing node-cron pattern. All 8 event types live in the registry with Zod schemas; the drill exercises `document.created`.
- **Repo conventions:** migrations 039+ mirrored into `schema.sql` (fresh-install snapshot convention); `/ready` extended to assert new oauth/webhook tables (silent-migration guard — Week-5 lesson); per-test-workspace cleanup for new tables (no truncation), matching `agent_*` convention; deploys only via the CI deploy job (`auto_deploy=false`).
- **Render Starter is single-instance**, which *justifies* in-memory token bucket + in-process outbox poller as must-ship, with the queue-backed deliverer as the documented Liskov drop-in for multi-instance scale — a defense answer, not a shortcut.

## Build sequence (day-by-day; each slice = branch + PR naming its acceptance criterion)

**Sun Aug 10 (today — defense-first, then foundation):**
1. Pre-Search doc (`PRESEARCH-W6.md`): all 3 phases answered; this session saved as the AI-conversation artifact.
2. Defense package: `docs/defense-week6.md` (architecture plan: named components, coordination, ownership, tradeoff ledger, AI-vs-deterministic = trivially "platform is LLM-free; one LLM call per agent turn"), one-pager, DECISIONS.md entries (terraform topology call; outbox-as-queue; hand-roll OAuth; FleetBus disqualification; thin-handlers-no-service-layer; Stripe-CLI tail relay).
3. **Terraform defense drill:** one-page dependency map of `terraform/render/` + the SSM/IAM piece; 2–3 mock rounds — I mutate a plan, James narrates resource changes + blast radius cold. (Auto-fail item; highest priority today.)
4. Tonight: migrations 039+ (oauth_apps, codes, tokens), `/api/v1` router mounted with boundary lint rule (before any cross-imports exist), ApiError class + error middleware + fitness-test skeleton, bearer-path 30s throttle fix.

**Mon Aug 11:** Defense 1:00 PM CT. Build: PKCE end-to-end (authorize → consent → token; S256; wrong-verifier → `invalid_grant` Playwright negative), Device Grant (user_code/device_code/verify/poll/slow_down), token middleware (401 invalid/missing, distinct expired code), ScopeRegistry + `require(scope)` factory (403 names missing scope), documents GET-list/GET/POST with cursor pagination, OpenAPI 3.1 v1 registry + route factory + `/api/v1/openapi.json` + 3.1 schema unit test. Epic-7 seam prototype (ShipData port extraction — proves the rewire path).

**Tue Aug 12 (MVP gate 11:59 PM):** SDK skeleton (`new ShipClient({token}).me()` typed), refresh rotation + family invalidation, deploy + pre-registered read-only grader OAuth app + README credentials, regression run (`bench/` P95 + bundle + query counts vs Part-1 baseline, ≤+10%), terraform plan annotated artifact refresh. **Walk the 11-item MVP checklist; every box checked with evidence before midnight.**

**Wed Aug 13:** Webhooks end-to-end: event registry (8 types, Zod, in shared), IEventBus + chokepoint publish (WEBHOOKS_ENABLED-first; `test/setup.ts` gets the flag), subscriptions CRUD (`webhooks:manage`; **signing secret hashed at rest, raw shown once** — parallel to client_secret), HMAC signer (`t=,v1=`; positive/negative/replay/tamper unit suite), outbox deliverer + retry ladder w/ jitter (deterministic clock injection — zero setTimeout in tests), 4xx→permanent DLQ, 6-fails→DLQ, delivery log, replay endpoint w/ original Idempotency-Key, relay endpoint for tail.

**Thu Aug 14 (early submission 11:59 PM):** SDK full (documents/issues/sprints/webhooks clients, async-iterator pagination, typed error union, `verifyWebhook` <1ms, deviceLogin/authorizationCodeFlow/clientCredentials, route manifest), spec↔SDK parity fitness test, CLI (`ship login` w/ immediate confirmation, `ship docs ls/get/create`, `ship webhooks tail` w/ "listening…" + "signature verified" verdict), TTFE drill (`pnpm drill ttfe`) wired into CI with stage timing. Submit early. Then: IAM duplicate-identity swap window (smoke + rollback ready).

**Fri Aug 15:** Dev portal (apps list/register, secret shown-once + rotate, subscriptions, delivery log w/ server-side pagination, replay button — consumes public API only), rate limiting (token buckets per-app+per-token, X-RateLimit-* on 100% responses, 429+Retry-After), public audit trail + portal view, **Epic 7 rewire** (SDK client behind feature flag; Part-2 tests pass ON and OFF; agent app seeded by migration; audit rows prove citizen traffic), refresh-rotation drill + Idempotency drill as named integrations.

**Sat Aug 16 (Sat):** Slack integration (signed webhooks → channel posts), browser SDK demo (PKCE SPA listing documents), drift-detection demo + destroy-redeploy evidence refresh, IAM before/after policy artifact w/ per-permission rationale, docs/architecture.md (all 9 required sections), AI cost analysis (tracked dev spend + 4-tier projections + explicit fanout/agent-active-rate/retention assumptions), per-epic write-ups, three discoveries, 20-consecutive-CI-run flake evidence (start runs Friday night), 30-min clean-machine TTFE walkthrough following only published docs.

**Sun Aug 17 morning:** demo video (five-line story + portal replay), social post (@GauntletAI, webhooks-tail screenshot, hook→receipts→lesson format), final requirements-ledger sweep, submit by 11:59 AM.

## Self-prompting loop (runs throughout, per owner instruction)

- **Requirements ledger:** `docs/week6-requirements.md` — every doc requirement as a row (verbatim quote → MET/PARTIAL/MISSING → evidence file:line). Created today from the extracted PDF; updated at the end of every slice. This is the loop's anchor.
- **Deviation rule:** any deviation from this plan is checked against the PDF requirement rows before it lands, and logged in DECISIONS.md with a `Rejected:` clause. No silent drift.
- **Per-slice gate:** each PR description names the acceptance criterion it advances + confirms the fitness test passed (itself a doc requirement).
- **Daily self-prompt (end of day):** re-read the ledger's non-MET rows; re-read tomorrow's slice against the doc's exact wording; escalate to James anything that needs an owner call.
- **Final gate (Sat night):** plan check (every step done or consciously skipped) → diff reconciliation (every change traces to a step) → acceptance check (every criterion verified against code) — the three-lens skill's 8a/8b/8c.

## Verification

- MVP: the 11-item hard-gate checklist, each with a named test (PKCE Playwright incl. negative; 401/403 middleware tests; ApiError fitness test; OpenAPI 3.1 schema unit test; `.me()` against running server; bench re-run ≤+10%; deployed URL + grader app).
- Testing-scenario coverage: the doc's 8 numbered testing scenarios each map to a named test file (retry-schedule test via injected clock; 6-failure DLQ + portal replay test; tamper/expiry signature tests; TTFE drill in CI).
- Performance targets table: TTFE <60s CI / ≤30min human; PKCE round-trip P95 <3s; spec parity 100%; delivery P95 <2s; rate-limit headers 100%; sig verify <1ms; SDK <250KB min+gz (size check in CI); 0% flake over 20 runs; **TTFE drill has a configured threshold that fails the build on regression** (doc-named requirement).
- Defense: mock terraform rounds today; Q&A brief built from the doc's interview questions Sat.
- **Completeness-sweep additions (vs. doc, this session):** static spec copy committed at `docs/openapi.json` (Submission table row) + v1 docs UI (Redoc/Swagger) at a stable URL; Epic-7 **before/after token-volume measurement via LangSmith traces** proving the rewire didn't change token shape (doc-named proof); pagination fitness test asserts **cursor stability across reordering**, not just presence; `request_id` as the end-to-end correlation ID (ApiError ↔ audit trail ↔ delivery log — one grep answers "what happened in what order"); README one-command grader setup for the CLI against the deployed instance (pre-search 3.4).

## Out of scope (deliberate)

Service-layer extraction; message broker; OAuth libraries; ECS side-stack (owner call); resurrecting the inherited AWS EB stack; platform-layer LLM features; npm publish (documented only); plugin runtime (stretch item, skipped); notification inbox.

## Residual risks (stated, owner-visible)

1. Terraform ECS-language gap rides on the Render-topology decision + open documentation of the mapping. Mitigation: defense mapping table + the SSM/IAM piece is real IAM on the live system.
2. Hand-rolled OAuth by a first-time OAuth-server author — mitigated by the de-scope ladder (Tier 1/Tier 0), RFC-keyed test matrix, and starting tonight.
3. Slack slippage leaves 4 of 5 integrations — mitigated by building Slack first on Saturday, before polish items.
