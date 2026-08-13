# Week 6 — MVP Rubric

The MVP is a **hard gate**: the assignment states "All items required to pass."
This file is the checkable form of that list. Each row is the requirement as
written, the verdict, and the specific artifact that backs it — a file, a test
name, a measured number, or a URL. Nothing is checked off on the strength of a
description.

**Standing rule:** a claim only survives here if the code supports it. Two
independent audits (an adversarial contract audit and a security review) were
run against this work *before* it merged, and every defect they found is listed
at the bottom with its fix and the regression test that locks it down.

Test totals at time of writing: **api 845 (61 files) · sdk 81 · cli 76 · web 165 · Playwright PKCE e2e 8**.

---

## The eleven MVP items

**10 of 11 fully met; item 9 is split** — its performance clause passes with
measured numbers, its Playwright-regression clause is not yet demonstrated.
Marked ◐ rather than ☑ for that reason.

### ☑ 1. OAuth app registration
> "admin can create an app, receive a client_id, and a client_secret hashed in the database (raw secret shown exactly once on creation)"

| | |
|---|---|
| Endpoint | `POST /api/oauth-apps` — `api/src/routes/oauth-apps.ts` |
| Issuance | `registerApp()` — `api/src/platform/oauth/service.ts` |
| Hashed at rest | `oauth_apps.client_secret_hash` (SHA-256) + an 8-char display prefix; migration `039_platform_oauth.sql` |
| Shown once | Raw secret returned only from create and rotate; `Cache-Control: no-store`; the list endpoint is asserted never to contain it |
| Tests | `api/src/routes/oauth-apps.test.ts` — 9, incl. "stores only the hash", rotation invalidating the old secret, cross-workspace 404 |

**Why session-authed rather than a `/api/v1` route:** registering your first app
is the bootstrap step — gating it behind an OAuth token would require a token
you cannot obtain without an app. Stripe, GitHub and Slack all manage app
credentials from a session dashboard for the same reason. Everything the portal
does *after* bootstrap goes through `/api/v1`.

### ☑ 2. Authorization Code + PKCE end-to-end via Playwright
> "…via a Playwright test: /oauth/authorize → consent → /oauth/token → usable access token" + "a wrong code_verifier … returns invalid_grant (negative case is mandatory)"

| | |
|---|---|
| Spec | `e2e/oauth-pkce.spec.ts` — 8 tests |
| Run | `pnpm exec playwright test e2e/oauth-pkce.spec.ts` |
| Mandatory negative | wrong `code_verifier` → 400 `invalid_grant` ✔ |
| Also covered | code replay → `invalid_grant`; `redirect_uri` mismatch → `invalid_grant`; denial → `access_denied` with `state` and no code; scope escalation → `invalid_scope` at both `/authorize` and `/authorize/decision`; RFC 7636 Appendix-B vector asserted so a broken PKCE helper cannot make the negative pass for the wrong reason |
| "Usable" is proven honestly | the human half runs through `page.request` after a real form login (session cookie + CSRF as a browser); the token half runs through the **cookie-free** `request` fixture, so the token works for a party holding no session |

### ☑ 3. Bearer middleware on every `/api/v1/*` route
> "invalid tokens return 401, missing tokens return 401, expired tokens return 401 with a distinct error code"

| | |
|---|---|
| Gate | `tokenGate` — `api/src/platform/api/v1/middleware/authn.ts` |
| Distinct expired code | `token_expired`, separate from `unauthorized` — `api/src/platform/api/v1/errors.ts` |
| Tests | `middleware/authn.test.ts` — missing header, non-bearer scheme, unknown token, revoked, **expired → `token_expired`**, deactivated app |
| "Every route" is enforced, not assumed | the fitness test walks the **live Express stack** and fails if any route is mounted without going through the factory (see item 5) |

### ☑ 4. Documents resource with a `require(scope)` factory
> "GET list, GET by id, and POST. Each route declares its required scope via a require(scope) middleware factory."

| | |
|---|---|
| Routes | `GET /api/v1/documents`, `GET /api/v1/documents/:id`, `POST /api/v1/documents` (+ issues, sprints, me — 8 total) — `api/src/platform/api/v1/resources/routes.ts` |
| Handlers | `resources/documents.ts` — thin, own scoped SQL, never import internal handlers |
| Factory | `requireScope(scope)` — `middleware/scope.ts` |
| Structurally required | `scope` is a required field of `V1RouteDef`, so a scope-less route does not compile |
| Tests | `resources/resources.test.ts` — 12, incl. `POST` with a read-only token → 403 naming `documents:write` |

### ☑ 5. Consistent `ApiError` shape, asserted by a fitness test over all routes
> "{code, message, details?, request_id} returned on every public failure, asserted by a fitness test over all /api/v1 routes"

| | |
|---|---|
| Envelope | `api/src/platform/api/v1/errors.ts` |
| Fitness test | `contract.fitness.test.ts` — issues a **live unauthenticated request to every catalogued route** and asserts the exact key set and that `request_id === X-Request-Id` |
| Edge cases the audit forced | body-parser failures (malformed JSON, oversized payload) and **429 rate-limit responses** now ship the envelope too — both are raised by middleware mounted *above* the v1 router and previously escaped it |
| Anti-cheat | the fitness test walks the real router stack, so a hand-mounted route cannot hide from it; verified by planting a rogue route and watching the test fail |
| Tests | `contract.fitness.test.ts` (13), `envelope-edges.test.ts` (3), `audit-fixes.test.ts` (9) |

### ☑ 6. ScopeRegistry with scopes-as-data; 403 names the missing scope
> "insufficient scope returns 403 with the missing scope named explicitly in the error body (no opaque 'forbidden')"

| | |
|---|---|
| Registry | `api/src/platform/scopes/registry.ts` — all 7 scopes as data |
| Extension test | adding a scope means editing the registry, never the middleware; `assertKnown()` runs at factory time so a typo'd scope is a **boot failure**, not a silent always-403 |
| 403 body | `{code:'forbidden', message:"…requires 'documents:write'", details:{missing_scope:'documents:write'}}` |
| Tests | asserted in `authn.test.ts`, `resources.test.ts`, `sdk-live.test.ts`, and `oauth-pkce.spec.ts` |

### ☑ 7. OpenAPI 3.1 generated from route metadata
> "served at /api/v1/openapi.json, generated from route metadata (never hand-written), validating against the OpenAPI schema in a unit test"

| | |
|---|---|
| Generator | `OpenApiGeneratorV31` — `api/src/platform/openapi/v1-registry.ts` |
| Generated, not written | the route factory registers the OpenAPI operation **and** mounts the handler in one call — `openapi/route-factory.ts` |
| Served | `GET /api/v1/openapi.json` (unauthenticated by design — docs precede having a token) |
| Static copy | `docs/openapi.json`, a build artifact from the same generator (`pnpm --filter @ship/api openapi:v1`) |
| Validity test | `contract.fitness.test.ts` → "validates against the OpenAPI 3.1 structural schema": version, required keys, per-operation shape, and **every `$ref` resolved inside the document** |
| Parity | bidirectional — every catalogued route has a spec entry AND every spec operation has a serving route |

### ☑ 8. SDK skeleton — `new ShipClient({token}).me()` against a running server
> "SDK skeleton exists in a pnpm workspace package; `new ShipClient({ token }).me()` against a running server returns the typed authenticated user"

| | |
|---|---|
| Package | `sdk/` — `@ship/sdk`, in `pnpm-workspace.yaml`, **zero runtime dependencies** |
| Size | **13.9 KB gzipped** — 5.6% of the 250 KB budget |
| Unit tests | 81 across 7 files, all with an injected fake `fetch` |
| **Live-server proof** | `api/src/platform/api/v1/sdk-live.test.ts` — 9 tests booting the real app on an ephemeral port with a real OAuth token in Postgres |
| Typed | the result is annotated `const me: ShipUser`, so a shape regression breaks compilation |
| Also proven live | create→get→list round-trip, async-iterator pagination over 7 rows with no cursor visible, the typed error union, and `request_id` byte-identical across the SDK boundary |

### ◐ 9. Regression suite + performance within +10% of the Part-1 baseline
> "P95 latency, bundle size, and per-route query counts within +10% of the Part 1 baseline"

Measured, not asserted — `docs/week6-perf-regression.md`:

| Metric | Baseline | Measured | Delta | Verdict |
|---|--:|--:|--:|:--|
| Bundle raw | 2,321.58 kB | 2,349.68 kB | +1.21% | PASS |
| Bundle gzip | 700.93 kB | 717.95 kB | +2.43% | PASS |
| P95 `/api/issues` c=10 | 181.7 ms | 72.3 ms | **−60.2%** | PASS |
| P95 `/api/projects` c=10 | 120.7 ms | 19.5 ms | **−83.8%** | PASS |
| P95 `/api/auth/me` c=10 | 83.3 ms | 12.2 ms | **−85.4%** | PASS |
| Main page cold queries | 57 | 32 | **−43.9%** | PASS |
| api / web / sdk suites | — | 660 / 160 / 81 | — | all green |

**The performance clause passes. The regression-suite clause does not yet.**
The full Playwright suite did not run green here: 8 specs failed under
3-worker contention on a loaded machine, and five specs carry `// FIXME:`
markers while still running unskipped (`e2e/AGENTS.md:174` says they belong in
`test.fixme()`). This branch changes no frontend code — `git diff
main...feat/w6-foundation -- web/` is empty — so it cannot have broken them,
but "did not break it" is not the same as "demonstrated green," and this row
stays ◐ until a quiet-machine or CI run says otherwise. The Playwright
evidence that *is* green is `e2e/oauth-pkce.spec.ts`, 8/8, which is what MVP
item 2 requires.

On the numbers themselves: latency improved partly because the bearer path's
per-request `last_used_at` UPDATE is now throttled to 30 s, but the perf
document is explicit that **most** of the gain is not Week 6's doing —
different hardware and post-audit work already on `main`. The comparison is
otherwise conservative: measured against **more** data than the baseline
(626 documents vs 557, 61 sprints vs 35).

### ☑ 10. Deployed and publicly accessible
> "deployed Ship + published OpenAPI spec URL + at least one OAuth app pre-registered with read-only scopes for graders"

| | |
|---|---|
| Instance | `https://ship-api-r1om.onrender.com` (Terraform-managed, Render) |
| Deploy path | merged to `main`; CI runs checks + secret-scan, then the deploy job |
| Grader app | `pnpm --filter @ship/api seed:grader-app` — read-only (`documents:read`, `issues:read`, `sprints:read`), idempotent, rotates on re-run so the published secret is always the working one |
| README | grader section with endpoints, credentials placeholder, and the one-command CLI setup |
| Live verification | `/ready` → `{"status":"ready","agent_tables":true,"platform_tables":true}` · `/api/v1/openapi.json` → 200, `openapi: 3.1.0` · unauthenticated `/api/v1/me` → 401 with a real `request_id` |
| Grader app | registered **through the live `POST /api/oauth-apps` endpoint**, which proves item 1 in production. `client_id ship_app_e46d52564bc1f690`, read-only scopes, credentials published in the README |
| Full flow proven on the deployed host | device code → `authorization_pending` → `slow_down` on rapid re-poll → approval → token exchange (`Bearer`, 3600 s, refresh issued) → `GET /api/v1/me` returns the typed user → `GET /api/v1/sprints` with an ungranted scope returns 403 naming `sprints:read` |

### ☑ 11. Terraform
> "a terraform/ directory with a complete config describing the deployment topology … Provider versions must be pinned … annotated terraform plan output … destroy-and-redeploy"

| | |
|---|---|
| Config | `terraform/render/` — project, Postgres, web service (the entire deployment) |
| Pinned | `render-oss/render` pinned **exactly** (not `~>`) in `versions.tf`, with `.terraform.lock.hcl` committed |
| Annotated plan + destroy/redeploy | `terraform/render/out/01–14`, incl. `13-destroy-week5.txt` and `14-apply-redeploy-week5.txt` |
| Blast-radius prep | `docs/defense-week6-terraform-map.md` — the 3-resource spine, per-resource blast radius, plan-symbol vocabulary, reading protocol |
| Stated gap | the requirement's ECS vocabulary ("app container", IAM task/execution roles) has no Render equivalent. Owner decision: defend the deployment that actually serves graders, map the gap openly (`docs/defense-week6.md` §10), and run least-privilege where real IAM exists in this codebase — the production secrets path (`api/src/config/ssm.ts`) |

---

## Defects found by audit before merge — all fixed, all locked down

| # | Severity | Defect | Fix + regression test |
|---|---|---|---|
| 1 | **CRITICAL** | A 429 on `/api/v1` returned `{error}`, not the envelope — the rate limiter is mounted above the v1 router and writes its body directly. The generated spec meanwhile *documented* `code: rate_limited`, so the published contract lied. Unprovokable in tests because the test env raises the limit to 10000. | Limiter now emits the envelope + `Retry-After` for `/v1` paths only; internal API shape unchanged. `app.ts` |
| 2 | **HIGH** (security) | CSRF on the consent endpoints matched `req.path` exactly, while Express routes case-insensitively and non-strictly — `POST /oauth/device/verify/` or `/VERIFY` **skipped the guard and still ran**, forging a device approval as the victim. Only `SameSite=Strict` was holding the line. | Path normalized the way the router matches; 5 forgery shapes locked down — `audit-fixes.test.ts` |
| 3 | **HIGH** | Cursor pagination ordered by the **mutable** `updated_at`: editing a not-yet-returned row moved it above the cursor and it was **never delivered** — silent data loss on any full walk, including SDK `iterate()`. The old test was a JS mock of the comparator and could not have caught it. | Sort key is now immutable `created_at`; proven against real SQL by editing an unseen row mid-walk — `audit-fixes.test.ts` |
| 4 | **HIGH** | Refresh-token TOCTOU: two concurrent presentations of a stolen token let the winner finish issuing *after* the loser revoked the family, so the attacker held live credentials in a family the server had already reported revoked. | `issueTokens` re-checks the family for revocations inside its own transaction and aborts; rotation maps that to `invalid_grant`. Race test with `Promise.all` asserts zero live refresh **and** access tokens — `service.test.ts` |
| 5 | **HIGH** (test integrity) | The fitness test enumerated the *catalog*, not the *router* — a hand-mounted route bypassing the factory was invisible to all four contract suites. | Now walks the live Express stack against the catalog plus a justified allowlist; **verified to fail on a planted rogue route** — `contract.fitness.test.ts` |
| 6 | MEDIUM (security) | `tokenGate` copied `is_super_admin` onto OAuth tokens, so an app authorized by a super-admin inherited admin — every internal authorization middleware short-circuits on that flag. | Super-admin is an identity property, not delegable; stripped for app-issued tokens — `audit-fixes.test.ts` |
| 7 | MEDIUM | Handlers read raw `req.query`; Zod strips unknown keys rather than rejecting, so undeclared params reached SQL — `?parent_id=notauuid` became a Postgres `22P02` → **500** on well-formed input. | Handlers read `req.validated.query`, so a route can only filter on what its schema publishes — `audit-fixes.test.ts` |
| 8 | MEDIUM | Malformed JSON on a `/api/v1` route returned an Express **HTML error page**. | Caught at app level, scoped to `/api/v1` so the internal contract is unchanged — `envelope-edges.test.ts` |

## Known-open, documented rather than hidden

These are real and deliberately deferred past the MVP gate. None affects an MVP item.

- **`redirect_uris` accepts non-http schemes** at registration (`javascript:`, `data:`). Not exploitable today — no consent UI reads `redirect_to` yet — but it must be an allowlist (`https:`, plus loopback `http:` per RFC 8252) before that UI ships.
- **Refresh grant performs no client authentication.** Contained: `issueTokens` derives identity from the stored row, so app B cannot redeem app A's token into a token for B. Still a spec deviation (RFC 6749 §6), and a deactivated app's refresh tokens keep rotating.
- **No rate limiting under `/oauth`.** The long credentials are 192–256 bits, so guessing is not the risk; the exposure is unbounded DB traffic and no cap on `user_code` attempts.
- **No device-code lookup endpoint**, so a consent screen cannot show the app name and scopes *before* approval (RFC 8628 §3.3).
- **`/ready` returns raw error text** to unauthenticated callers (pre-existing, Week 5).
- **`OPTIONS /api/v1/*` returns 204 without a token** — correct per the Fetch spec (CORS preflight must be unauthenticated) but worth stating before it is raised as an A3 objection.
