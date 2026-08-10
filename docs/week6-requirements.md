# Week 6 — PlugForge Requirements Ledger

Source: `GFA_Week_6_PlugForge.pdf` (18 pages). Every requirement below is quoted or tightly paraphrased from the doc.
Status vocabulary: **MET** (evidence cited) / **PARTIAL** (what exists + what's missing) / **MISSING** / **PLANNED** (scheduled, not started).
House rule: never let a claim outlive the code — a row only moves to MET with a file:line, test name, CI run, or URL.

Updated at the end of every slice. This ledger is the anchor of the week's deviation-check loop: any change of plan is checked against these rows before it lands.

## A. MVP hard gate (all required to pass — Tue Aug 12, 11:59 PM CT)

| # | Requirement (verbatim condensed) | Status | Evidence |
|---|---|---|---|
| A1 | OAuth app registration endpoint: admin creates app, receives client_id; client_secret hashed in DB; raw secret shown exactly once on creation | PLANNED (Sun night/Mon) | — |
| A2 | Authorization Code + PKCE completes end-to-end via Playwright: /oauth/authorize → consent → /oauth/token → usable access token | PLANNED (Mon) | — |
| A3 | Bearer middleware validates every /api/v1/* route; invalid 401, missing 401, expired 401 with distinct error code | PLANNED (Mon) | — |
| A4 | Documents resource: GET list, GET by id, POST; each route declares scope via require(scope) middleware factory | PLANNED (Mon) | — |
| A5 | Consistent ApiError {code, message, details?, request_id} on every public failure, asserted by fitness test over all /api/v1 routes | PLANNED (Sun night skeleton) | — |
| A6 | ScopeRegistry scopes-as-data; insufficient scope → 403 naming the missing scope explicitly | PLANNED (Mon) | — |
| A7 | OpenAPI 3.1 spec at /api/v1/openapi.json, generated from route metadata (never hand-written), validated against OpenAPI schema in a unit test | PLANNED (Mon) | — |
| A8 | SDK skeleton in pnpm workspace; `new ShipClient({token}).me()` returns typed authenticated user against running server | PLANNED (Tue) | — |
| A9 | Existing Playwright regression suite passes on main; P95 latency, bundle size, per-route query counts within +10% of Part 1 baseline | PLANNED (Tue bench re-run) | Baselines: AUDIT_REPORT.md:413-419, :290-296, :510-516 |
| A10 | Deployed + publicly accessible: deployed Ship + published OpenAPI spec URL + ≥1 OAuth app pre-registered with read-only scopes for graders | PLANNED (Tue) | Live base: https://ship-api-r1om.onrender.com |
| A11 | Terraform: terraform/ config describing deployment topology (app container, database, networking, IAM task role + execution role); provider versions pinned; annotated `terraform plan` output artifact; destroy-and-redeploy proof; read a modified plan at the Defense (blast radius) — inability = AUTO-FAIL | PARTIAL | Live stack terraform/render (provider pinned 1.9.1, destroy-redeploy proven Week 5: terraform/render/out/13-14). OWNER DECISION: Render topology stands; ECS-language gap ("app container", IAM task/execution roles) documented openly in defense mapping table; IAM exercise runs on real SSM identity (see D2). Residual risk stated in plan. |

## B. Core technical requirements

### B-OAuth / public API contract

| # | Requirement | Status | Evidence |
|---|---|---|---|
| B1 | oauth_apps table: id, client_id, hashed client_secret, redirect_uris, owner, requested_scopes; raw secret shown once on creation AND rotation, never recoverable | PLANNED | — |
| B2 | PKCE: code_challenge + method recorded at /oauth/authorize; code_verifier required at /oauth/token; mismatch → 400 invalid_grant | PLANNED | — |
| B3 | Device Grant: /oauth/device/code issues user_code + device_code; /oauth/device/verify accepts user_code; client polls /oauth/token; slow_down honored | PLANNED | — |
| B4 | Scope Registry as data: documents:read/write, issues:read/write, sprints:read/write, webhooks:manage; new scopes register at module load, never edit middleware | PLANNED | — |
| B5 | Token middleware populates request with app, user, granted scopes; invalid 401; insufficient scope 403 with missing scope named | PLANNED | — |
| B6 | One-time-use refresh tokens with rotation; reuse of stolen refresh token invalidates the family | PLANNED (Tue) | — |
| B7 | Public routes only at /api/v1/*; internal stays /api/; lint rule fails build if public route imports internal handler files | PLANNED (Sun night) | — |
| B8 | ApiError shape on every public failure; error middleware guarantees; fitness test verifies | PLANNED (Sun night) | — |
| B9 | Cursor pagination: opaque base64 over {id, timestamp}; lists always return {data, next_cursor}; cursors STABLE ACROSS REORDERING (fitness-tested) | PLANNED | — |
| B10 | OpenAPI 3.1 generated in-process from route metadata; served; schema-validated in unit test; spec parity asserted by fitness test | PLANNED | — |

### B-Webhooks

| # | Requirement | Status | Evidence |
|---|---|---|---|
| B11 | Event registry as data: document.created/.updated/.deleted, issue.created/.assigned/.status_changed, sprint.started/.completed — each with a Zod schema | PLANNED (Wed) | Note: sprint.* published by week-boundary cron check (weeks are time-computed; no natural write) |
| B12 | IEventBus interface; domain layer publishes on writes — never the route layer; in-process must-ship; queue-backed is a Liskov-substitutable drop-in | PLANNED (Wed) | Chokepoints: routes/issues.ts:646, utils/document-crud.ts:76-86; gated WEBHOOKS_ENABLED before any query |
| B13 | Per-app per-event-type subscriptions: target URL, hashed signing secret, active flag; managed via /api/v1/webhooks gated by webhooks:manage | PLANNED (Wed) | — |
| B14 | HMAC-SHA256 Stripe-style header Ship-Signature: t=<unix-seconds>,v1=<hex-hmac>; timestamp prevents replay; SDK rejects signatures older than 5 min by default | PLANNED (Wed) | — |
| B15 | Retry schedule: exponential backoff with jitter 1s, 4s, 16s, 1m, 5m, 30m; 5xx/timeout retried; 4xx permanent → dead-letter | PLANNED (Wed) | Deterministic clock injection; no setTimeout in tests |
| B16 | After 6 failed attempts → DLQ visible in developer portal; manual replay carries original idempotency key | PLANNED (Wed/Fri) | — |
| B17 | webhook_deliveries table: subscription_id, event_id, attempt_number, response_status, response_excerpt, latency_ms; queryable per app | PLANNED (Wed) | — |
| B18 | /api/v1/webhooks/deliveries/:id/replay re-emits logged event; Idempotency-Key header passed through | PLANNED (Wed) | — |

### B-SDK / rate limiting / portal

| # | Requirement | Status | Evidence |
|---|---|---|---|
| B19 | @ship/sdk resource clients: documents, issues, sprints, webhooks; signatures match OpenAPI; drift fails CI via fitness test | PLANNED (Thu) | Mechanism: SDK route manifest diffed vs spec both directions |
| B20 | ShipClient.authorizationCodeFlow() and .deviceLogin() end-to-end; pluggable ITokenStore (memory, file, browser localStorage) | PLANNED (Thu) | +clientCredentials() for agent app |
| B21 | Async-iterator pagination: for await (const doc of client.documents.iterate()); cursors never visible to consumers | PLANNED (Thu) | — |
| B22 | verifyWebhook(headers, rawBody, secret) → boolean; tampered fails, expired fails, missing v1 fails | PLANNED (Thu) | — |
| B23 | SDK errors are a discriminated union: kind: auth \| rate_limit \| not_found \| validation \| server; exhaustively switchable | PLANNED (Thu) | — |
| B24 | Per-app AND per-token token-bucket rate limits; X-RateLimit-Limit/-Remaining/-Reset on public responses; 429 carries Retry-After | PLANNED (Fri) | 100% of public responses (perf target) |
| B25 | Public audit trail: every public call — timestamp, app client_id, user_id, route, scope used, status, latency; queryable in portal | PLANNED (Fri) | request_id doubles as end-to-end correlation ID |
| B26 | Dev portal: list apps, register apps, view/rotate client_secret (shown once), manage subscriptions, browse delivery log, replay failed deliveries | PLANNED (Fri) | Consumes public API only (dog food) |

## C. Terraform & infrastructure

| # | Requirement | Status | Evidence |
|---|---|---|---|
| C1 | terraform/ topology; all provider + module versions pinned; terraform plan runs cleanly; no unpinned versions | PARTIAL | terraform/render/versions.tf pins render-oss/render 1.9.1; re-verify plan cleanly this week |
| C2 | IAM least-privilege: start AdministratorAccess task role → lock to minimum; verify service works; verify out-of-policy action denied; before/after policy with per-permission rationale | PLANNED (Thu after early sub) | On real SSM Parameter Store identity; duplicate identity first (zero blast radius), prod swap w/ rollback |
| C3 | Drift: manually change a resource, terraform plan shows diff; destroy → apply from scratch; screenshots/log proof service came back identically | PARTIAL | Week-5 proof exists (terraform/render/out/); refresh with week-6 resources Sat |
| C4 | Defense: walk a modified terraform plan — every resource change, blast radius, risky ops — WITHOUT AI. Auto-fail if unable | IN PREP (today) | One-pager map + mock rehearsal rounds today |

## D. Testing scenarios (doc §Testing Scenarios, numbered 2–9)

| # | Scenario | Status | Test |
|---|---|---|---|
| D2 | PKCE flow in Playwright from registered web app; wrong code_verifier → invalid_grant (negative case mandatory) | PLANNED | e2e (Mon) |
| D3 | Device flow from test CLI: poll until authorized; slow_down honored; token works against /api/v1/me | PLANNED | — |
| D4 | Fitness test enumerates every /api/v1 route: (a) OpenAPI entry (b) declares scope (c) ApiError on failure paths (d) cursor pagination if list | PLANNED | — |
| D5 | Validate openapi.json against OpenAPI 3.1 JSON schema; walk every spec method, assert SDK exposes a typed call | PLANNED | — |
| D6 | Subscription via SDK → create document → signed POST arrives <2s → SDK verifies → tampered body rejected | PLANNED | — |
| D7 | Subscriber 500s ×3 then 200: retry waits ≥1s/4s/16s before attempts; 4th records success in delivery log | PLANNED | Injected clock |
| D8 | 6 consecutive failures → DLQ visible in portal → Replay against healthy subscriber succeeds with original idempotency key | PLANNED | — |
| D9 | TTFE drill end-to-end from clean container: install → login → create → verified webhook, <30min human / <60s CI | PLANNED | `pnpm drill ttfe` |

## E. Performance targets

| Metric | Target | Status |
|---|---|---|
| TTFE (clean machine, docs only) | ≤ 30 min; CI < 60 s (P95) | PLANNED |
| OAuth Auth Code + PKCE round-trip P95 | < 3 s | PLANNED |
| OpenAPI spec parity (fitness) | 100% | PLANNED |
| Webhook delivery P95 (first attempt) | < 2 s | PLANNED |
| Retry success after transient 5xx | 100% within schedule | PLANNED |
| Public responses with rate-limit headers | 100% | PLANNED |
| Telemetry vs Part-1 baseline | ≤ +10% P95 / bundle / query counts | PLANNED (bench re-run Tue) |
| Drill flake rate over 20 consecutive CI runs | 0% | PLANNED (runs start Fri night) |
| Webhook signature verification (SDK) | < 1 ms/call | PLANNED |
| SDK install size (prod deps, min+gz) | < 250 KB | PLANNED (CI size check) |
| Drill regression threshold | configured; past it fails the build | PLANNED |

## F. Signature challenge required capabilities

| Capability | Status |
|---|---|
| `pnpm drill ttfe` runs full loop vs containerized Ship from clean working dir | PLANNED |
| Per-stage timing instrumentation (install, login, subscribe, create, receive, verify) in ms | PLANNED |
| One-line SDK verification; tampered/expired fail, valid passes | PLANNED |
| Drill in CI on every PR; regression past threshold fails build | PLANNED |

## G. Integrations (5 of 7; CLI must-ship)

| Pick | Status |
|---|---|
| CLI: ship login (device flow), ship docs ls/get/create, ship webhooks tail | PLANNED (Thu) — must-ship |
| Refresh-token rotation drill (stolen reuse invalidates family) | PLANNED (Fri) |
| Idempotency-Key end-to-end dedupe drill | PLANNED (Fri) |
| Browser SDK demo (Auth Code + PKCE SPA listing documents) | PLANNED (Sat) |
| Slack integration (signed webhooks → channel posts via Slack OAuth) | PLANNED (Sat, early — margin item) |

## H. Submission deliverables (Final: Sun Aug 16, 11:59 AM CT)

| Deliverable | Requirement | Status |
|---|---|---|
| GitHub repository | Public; per-slice branches preserved; each PR lists acceptance criterion + fitness test confirmation | IN PROGRESS (branch discipline from today) |
| Demo video 3–5 min | Five-line story + dev-portal replay of one delivery | PLANNED (Sun) |
| Pre-Search document | All 3 phases written; saved AI conversation attached | IN PROGRESS (today) |
| Architecture document | docs/architecture.md, 1–2 pages, 9 required sections (module layout, SOLID w/ file paths, composition root, public/internal boundary seq diagram, OAuth flow diagrams, webhook pipeline, SDK surface, agent-as-citizen before/after, failure modes) | PLANNED (Sat; skeleton in defense doc today) |
| OpenAPI spec | Live at /api/v1/openapi.json on deployed instance + static copy at docs/openapi.json | PLANNED |
| AI cost analysis | Tracked dev spend; projections at 100/1k/10k/100k users; explicit assumptions: webhook fanout ratio, agent active rate, storage retention | PLANNED (Sat) |
| Per-epic write-up | Before → fix → after → proof (E6 proof = TTFE in CI; E7 proof = agent audit-log rows) | PLANNED (rolling) |
| Three discoveries | Candidates: Device Grant in TS; Zod→OpenAPI parity; HMAC+timestamp anti-replay; async-iterator pagination | PLANNED (rolling) |
| Deployed application | Public URL + pre-registered read-only OAuth app + credentials in README; portal reachable; spec resolvable | PLANNED (Tue deploy, rolling) |
| Social post | @GauntletAI; screenshot = ship webhooks tail showing verified signed event live | PLANNED (Sun) |
| Epic-7 token-volume proof | Rewire doesn't change token volume — before/after via LangSmith traces | PLANNED (Fri) |

## I. Critical guidance compliance (doc §Critical Guidance)

| Rule | Status |
|---|---|
| Public/internal split enforced by lint from day 1 (before any cross-imports exist) | PLANNED (tonight) |
| OpenAPI generated, never hand-written | PLANNED (route-factory design) |
| In-memory deliverer resolves synchronously in unit tests; real deliverer tested with deterministic clock injection — never setTimeout waits | PLANNED |
| One LLM call per agent turn; platform never invokes the LLM | COMPLIANT BY DESIGN (platform is LLM-free; FleetGraph unchanged) |
| integrations/ imports only @ship/sdk — never api/src — enforced by workspace dependency rule | PLANNED (lint rule tonight) |
| TTFE drill in CI from Day 5 onward | PLANNED (Thu) |
