# Ship Platform Architecture

**Status banner.** This describes the platform layer added in Week 6. Sections are
marked **shipped** (code exists, tests cited) or **designed, not yet wired**
(the interface exists, the implementation is scheduled). Nothing here claims
capability the repository does not contain — evidence for every shipped claim is
in [`docs/week6-mvp-rubric.md`](week6-mvp-rubric.md).

| Area | State |
|---|---|
| OAuth 2.0 server (PKCE, device grant, refresh rotation, client credentials) | **shipped** |
| Public `/api/v1` (authn, scopes, ApiError, cursor pagination) | **shipped** |
| OpenAPI 3.1 generated from route metadata | **shipped** |
| `@ship/sdk` typed client | **shipped** |
| Developer portal UI | designed, not yet wired |
| Webhooks (registry, bus, signer, deliverer, DLQ, replay) | designed, not yet wired |
| Rate limiting per app/token, public audit trail | partial — limiter returns the public envelope; per-app buckets and the audit table are scheduled |
| Agent-as-citizen rewire (Epic 7) | designed, not yet wired |

---

## 1. Module layout

```
api/src/platform/            the entire public surface; imports nothing from api/src/routes
├── oauth/
│   ├── service.ts           grants, token issuance, refresh families, PKCE verification
│   ├── routes.ts            /oauth/authorize, /token, /device/code, /device/verify
│   └── errors.ts            RFC 6749 §5.2 error bodies — deliberately NOT ApiError
├── scopes/registry.ts       scopes as data; the only place a scope is defined
├── openapi/
│   ├── v1-registry.ts       the 3.1 document + the machine-readable route catalog
│   ├── route-factory.ts     registers the spec operation AND mounts the handler in one call
│   └── serve-spec.ts        GET /api/v1/openapi.json (public, unauthenticated)
└── api/v1/
    ├── router.ts            request-id, ApiError 404, ApiError error handler
    ├── errors.ts            the one public error envelope
    ├── pagination.ts        opaque base64url keyset cursors
    ├── middleware/          authn.ts · scope.ts · request-id.ts  (one concern per file)
    └── resources/           schemas.ts · documents.ts · routes.ts (the route table)

api/src/routes/oauth-apps.ts app registration for the portal (session-authed; bootstrap)

sdk/src/                     @ship/sdk — zero runtime dependencies, 13.9 KB gzipped
├── client.ts                ShipClient + deviceLogin / authorizationCodeFlow / clientCredentials
├── resources.ts             documents · issues · sprints · webhooks clients
├── http.ts                  bearer injection, single-flight refresh, error mapping
├── webhook.ts               verifyWebhook(headers, rawBody, secret) — constant-time
├── manifest.ts              SDK_ROUTE_MANIFEST — what the parity test diffs against the spec
└── token-store.ts           ITokenStore: memory · file (0600) · localStorage
```

## 2. SOLID rationale, with file references

**Single responsibility.** The public request pipeline is one concern per file —
`middleware/request-id.ts`, `middleware/authn.ts`, `middleware/scope.ts`. They
fail differently (401 / 403), are tested separately, and can be reordered
without editing each other.

**Open/closed.** `scopes/registry.ts` is the OCP case. Adding `webhooks:manage`
meant registering a datum; no middleware changed. `requireScope()` asks the
registry a question and never enumerates scopes itself, so the set is open for
extension and the enforcement is closed for modification.

**Liskov.** `IWebhookDeliverer` (designed) has an in-process implementation that
resolves synchronously for tests and a queue-backed implementation for scale.
Substituting one for the other changes throughput, never the contract — the same
publish call, the same delivery-row semantics. This is the interface that makes
"we did not add a message broker" a deferral rather than a limitation.

**Interface segregation.** The SDK exposes `client.documents`, `client.issues`,
`client.sprints`, `client.webhooks` rather than one flat client. A CLI that only
creates documents never touches the webhook surface — `sdk/src/resources.ts`.

**Dependency inversion.** `createRouteFactory({ tokenGate, requireScope })`
takes its gates as parameters (`openapi/route-factory.ts`), so the factory
depends on `RequestHandler`, not on the auth module. That is what let the factory
and the middleware be built independently and wired at the composition root.

## 3. Composition root

`api/src/app.ts` is the single place concrete implementations are chosen:

```ts
// body parsers … then the public envelope guard for parse failures
app.use(bodyParserErrorToApiError);            // malformed JSON on /api/v1 → ApiError

// OAuth server. CSRF applied SELECTIVELY:
//   machine grants (/token, /device/code) exempt — clients hold no CSRF token
//   human consent (/authorize/decision, /device/verify) protected — a forged
//   POST there is a silent consent grant
app.use('/oauth', oauthCsrf, createOAuthRouter({ auth: authMiddleware }));

// Public API. No CSRF wrapper (no cookie auth accepted), no middleware shared
// with the internal routes below.
app.use('/api/v1', createV1Router(registerV1Routes));

// Internal API, unchanged from Weeks 1–5.
app.use('/api/documents', conditionalCsrf, documentsRoutes);
```

**Test wiring** is the sibling: suites call `createV1Router(register)` with stub
gates, or boot the real app on an ephemeral port
(`api/src/platform/api/v1/sdk-live.test.ts`). Spec registration is process-wide
while router mounting is per-router, because `createApp()` is called many times
across the suite.

## 4. Public/internal boundary

Both surfaces read the same tables; nothing else is shared.

```
            ┌──────────────── /api/v1 (public) ────────────────┐
 client ───▶│ request-id → authn → scope → handler → (audit)   │──┐
            └─────────────────────────────────────────────────┘  │
                                                                 ├──▶ Postgres
            ┌──────────── /api/* (internal, unchanged) ────────┐  │
 browser ──▶│ session/CSRF → authMiddleware → route handler    │──┘
            └─────────────────────────────────────────────────┘
```

Auth, scope checking, rate limiting and (scheduled) audit + webhook publication
attach **only** at the public layer. The boundary is enforced mechanically, not
by convention: `eslint.config.mjs` fails the build if `api/src/platform/**`
imports `**/routes/*`, or if `integrations/**` imports `api/src/**`. The rule
was added before any cross-import existed, because this is a one-way door.

Two independent tokens cannot cross either: `authMiddleware` selects
`WHERE oauth_app_id IS NULL`, so a scoped public token is refused by the
internal API, and `tokenGate` strips `is_super_admin` from app-issued tokens so
admin is never delegable.

## 5. OAuth flows

**Authorization Code + PKCE** (browser apps). Verifier is validated at the token
exchange, marked ★.

```
app          browser/user            Ship
 │  authorize?code_challenge=S256(v) │
 │──────────────────────────────────▶│  records challenge on the code row
 │            consent screen  ◀───────│
 │            approve ───────────────▶│  issues one-time code (10 min TTL)
 │  ◀── redirect ?code=…&state=…      │
 │  POST /oauth/token  code + verifier│
 │──────────────────────────────────▶│ ★ base64url(sha256(verifier)) == challenge
 │  ◀── access (1h) + refresh (30d)   │   mismatch → 400 invalid_grant
```

**Device Authorization Grant** (CLI — no browser to redirect back to).

```
CLI ── POST /oauth/device/code ─────▶ user_code + device_code (15 min)
CLI ── poll /oauth/token ───────────▶ authorization_pending
CLI ── poll again, too soon ────────▶ slow_down          (enforced server-side)
human ─ approves user_code in browser ▶ status: approved
CLI ── poll /oauth/token ───────────▶ tokens; code flips to consumed (exactly once)
```

**Refresh rotation** happens on every exchange: the presented token is claimed
and marked consumed in one statement, and a new pair is issued in the same
family. Presenting a consumed token is replay → the **entire family** is revoked,
including access tokens (`refresh_family_id`). Issuance re-checks the family for
revocations inside its own transaction, so a concurrent replay cannot leave the
attacker holding live credentials in a family already reported revoked.

## 6. Webhook pipeline — *designed, not yet wired*

```
domain write ─▶ IEventBus.publish ─▶ webhook_deliveries row (the outbox)
                                          │
                        deliverer polls ──┤ ★ signs: Ship-Signature: t=<unix>,v1=<hmac>
                                          ▼
                                     subscriber
                                          │ 5xx / timeout → retry 1s·4s·16s·1m·5m·30m + jitter
                                          │ 4xx or 6 failures → DLQ
                                          ▼
                        portal "Replay" ──▶ re-enqueue ✦ carrying the ORIGINAL Idempotency-Key
```

★ signature is computed at delivery time, over `t + "." + rawBody`.
✦ the idempotency key is minted from the event id at first attempt and travels
unchanged through every retry and every manual replay, so subscribers dedupe.

One table is the queue, the retry scheduler, the dead-letter queue and the
per-app delivery log, because the required retry ladder forces durable
persistence anyway. Publication happens in the domain layer at the existing
write chokepoints, never in a route handler, and is kill-switched
(`WEBHOOKS_ENABLED`) before any query — the same ordering Week 5 established so
strict `pool.query` mocks in route tests stay valid.

## 7. SDK surface

| Surface | Stability |
|---|---|
| `new ShipClient({token, baseUrl})`, `.me()` | stable |
| `client.documents` / `.issues` / `.sprints` — `list`, `get`, `create`, `iterate()` | stable |
| `ShipError` discriminated union (`auth`, `rate_limit`, `not_found`, `validation`, `server`) | stable |
| `verifyWebhook(headers, rawBody, secret, toleranceSec = 300)` | stable |
| `ITokenStore` (memory / file / localStorage) | stable |
| `ShipClient.deviceLogin()`, `.authorizationCodeFlow()`, `.clientCredentials()` | pre-1.0 |
| `client.webhooks` | pre-1.0 — server routes not yet wired |

Cursors never appear in consumer code: `iterate()` is an async generator that
walks pages internally. `SDK_ROUTE_MANIFEST` is load-bearing rather than
descriptive — `resources.ts` builds its URLs from it, so a method cannot call an
undeclared path, and CI diffs the manifest against the generated spec.

## 8. Agent as platform citizen — *designed, not yet wired*

```
BEFORE   FleetGraph ──── raw SQL ───▶ Postgres        invisible · unlimited · no trail
AFTER    FleetGraph ──▶ @ship/sdk ──▶ /api/v1 ──▶ Postgres   scoped · rate-limited · audited
```

The agent authenticates as a first-party OAuth app via client credentials — it is
machine-to-machine with no human present at boot, which rules out both the
device grant (needs a person) and the authorization code flow (needs a browser).
The rewire sits behind a feature flag so the Week-5 test suite passes with it on
and off. The payoff is the audit trail: rows carrying the agent's `client_id`
prove it uses the same front door as a stranger. If the platform were only
usable by giving our own agent a shortcut, we would not have built a platform.

## 9. Failure modes

**The token store is corrupted.** The SDK surfaces `kind: 'auth'` and the CLI
prompts re-login. It never silently retries — a retry loop against a bad
credential is how clients get rate-limited and users get confused.

**A subscriber's signing secret is rotated mid-flight.** Deliveries already
signed with the old secret fail verification at the subscriber, return 4xx, and
dead-letter; the rotation is visible in the delivery log. New deliveries use the
new secret. This is intended: the alternative — accepting either secret
indefinitely — means rotation never actually revokes anything.

**The queue deliverer crashes.** Outbox rows are committed before delivery is
attempted, so nothing is lost; the poller resumes on boot and re-attempts
in-flight rows. The contract is explicitly **at-least-once**, which is why every
delivery carries an idempotency key.

**The OpenAPI generator throws at boot.** The server refuses to start. A platform
whose published contract cannot be generated is misconfigured, and failing fast
in CI is better than serving traffic whose documentation silently disappeared.
The last known-good spec is committed at `docs/openapi.json`.

**The database is unreachable.** `/ready` returns 503 and asserts the platform
tables exist, so a silently-skipped migration cannot masquerade as a healthy
deploy — the failure mode that cost us a Week-5 deploy.
