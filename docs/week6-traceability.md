# Week 6 — Requirement Traceability

Every requirement in `GFA_Week_6_PlugForge.pdf` (18 pages), traced to the artifact that
satisfies it and to whether that artifact was **re-verified on 2026-08-16** or is being
cited from an earlier run.

**Why this file exists.** A reviewer found a hard-gate clause recorded as MET on the
strength of one measurement out of five. The failure was not the missing measurement —
it was that nothing forced the row to name what it had actually measured. This table
adds the column that would have caught it: *how it was verified, and when*.

**How to read the Verified column.**

| Mark | Meaning |
| --- | --- |
| **RAN** | The command was executed on 2026-08-16 and its output read. |
| **LIVE** | Asserted against the deployed instance on 2026-08-16, by response body — not by status code alone. |
| **CITED** | Backed by a committed artifact from an earlier dated run; not re-executed today. |
| **OPEN** | Not satisfied. The gap is stated in the row. |

Counts, **computed from this file's own tables rather than asserted** (93 requirement
rows across sections A–K):

| | |
| --- | --: |
| MET | **87** |
| PARTIAL — stated, not hidden | **2** |
| OWED — blocked on the owner | **3** |
| ACCRUING — needs elapsed CI runs, not effort | **1** |
| MISSING | **0** |

Six rows closed on 2026-08-16, each by doing the work rather than rewording the row:
Epic 7 wired and its audit rows captured · the portal Replay button fixed after an e2e
spec caught it returning 400 on every click · a PR-time TTFE drill added alongside the
main-only one · an ECS topology stack with an annotated offline plan · the `c7`
rate-limit probe corrected (it was unauthenticated, so it could never pass) · and two
requirement blocks that had **no rows at all** (sections J and K) traced for the first
time.

The row count rose from 81 to 93 for that last reason. A block with no rows cannot come
back MISSING, because nothing asks about it — which is the same failure shape as the
gate this document exists to close.

Nothing here is marked MET without a file, test name, measured number, or URL. The
first draft of this counts block was written from memory and was wrong in every figure —
the same failure mode as the gate this document exists to close. It is now computed from
the tables below, and that is recorded rather than quietly corrected.

---

## A. MVP hard gate — "All items required to pass"

| # | Requirement (abridged from the brief) | Status | Evidence | Verified |
| --- | --- | --- | --- | --- |
| A1 | OAuth app registration; secret hashed; raw secret shown exactly once | MET | `routes/oauth-apps.ts`; `oauth-apps.test.ts` (9) incl. "stores only the hash" | RAN — api 880 |
| A2 | Auth Code + PKCE end-to-end in Playwright; wrong verifier → `invalid_grant` | MET | `e2e/oauth-pkce.spec.ts` (8), incl. RFC 7636 Appendix-B vector | CITED |
| A3 | Bearer middleware on every `/api/v1/*`; expired → 401 with a **distinct** code | MET | `errors.ts:62` `token_expired`; `fitness.test.ts:68` asserts distinctness | RAN |
| A4 | Documents GET list / GET id / POST, each declaring scope via `require(scope)` | MET | `resources/routes.ts`; scope is a required field of `V1RouteDef` — a scope-less route cannot compile | RAN |
| A5 | `ApiError {code,message,details?,request_id}` on every failure, fitness-tested | MET | `contract.fitness.test.ts` issues a live unauthenticated request per catalogued route | RAN |
| A6 | ScopeRegistry scopes-as-data; 403 names the missing scope | MET | `scopes/registry.ts` (7 scopes); `details.missing_scope` | RAN |
| A7 | OpenAPI 3.1 at `/api/v1/openapi.json`, generated, schema-validated in a unit test | MET | Route factory registers spec + handler in one call; live spec is **3.1.0, 11 paths, 13 operations**, real JSON not an SPA fallback | LIVE + RAN |
| A8 | SDK in a pnpm workspace; `new ShipClient({token}).me()` returns the typed user | MET | `sdk-live.test.ts` (9) boots the real app; **14.3 KB gzip, 5.7% of budget** | RAN — `pnpm --filter @ship/sdk size` |
| A9 | Regression suite passes; **P95, bundle, per-route query counts** within +10% | PARTIAL | **Perf clause MET** — all five flows 57→46, 64→54, 61→41, 67→48, 57→53; bundle +1.21%/+2.43%. **Regression clause: every test now executes, but no clean whole-suite green.** Sharded 4× sequential: **845 passed · 1 failed · 3 flaky · 36 skipped · 0 did not run** — the 41 worker-death losses eliminated. The failure is a typing-**latency** benchmark (`performance.spec.ts:228`) that passes in isolation, and it is a *different* test from the single-process run's failure (`program-mode-week-ux.spec.ts:488`, also passes alone). Two runs, two different failures, each green solo = contention. PARTIAL because a single uninterrupted green run has not been produced on this hardware | RAN — `evidence/2026-08-16/e2e-shards/` |
| A10 | Deployed + published spec URL + a pre-registered read-only OAuth app for graders | MET | `/ready` → `platform_tables:true`, commit `c203e22` **== local HEAD**; grader app issues a device code live | LIVE |
| A11 | Terraform topology, pinned providers, annotated plan artifact, destroy-and-redeploy, plan read at defense | MET | Provider pinned `1.9.1`; `terraform/render/out/13-destroy-week5.txt`, `14-apply-redeploy-week5.txt`. ECS-vocabulary gap **closed 2026-08-16**: `terraform/ecs/` describes the topology the brief names — app container (`aws_ecs_task_definition`), database, networking, and the two IAM roles separately — pinned `aws 5.82.2`, `Plan: 31 to add`, annotated at `terraform/ecs/out/PLAN-ANNOTATED.md`. Plan-only and says so: Render remains the live deployment. Plans with no AWS credentials, so anyone reproduces it | RAN |

### A9 in detail — the clause the review caught

| Flow | Baseline (cold) | Measured | Delta | |
| --- | --: | --: | --: | :-- |
| Main page `/my-week` | 57 | 46 | −19.3% | PASS |
| Document view | 64 | 54 | −15.6% | PASS |
| Issues list | 61 | 41 | −32.8% | PASS |
| Week board | 67 | 48 | −28.4% | PASS |
| Search (Cmd-K + one `@`-mention) | 57 | 53 | −7.0% | PASS |

Two passes agreed **exactly**; 77 URLs, zero non-200. Control: the preserved audit-era
call set still returns **32**, identical to `out/after-9c00675_mainpage.txt`, which
validates the instrument and shows the counts are volume-insensitive at the drifted
626-document dataset. Measured with the post-audit schedulers off — with them on, an
early pass read 64 instead of 46.

---

## B. Core technical requirements

### OAuth + public API contract (9)

| Requirement | Status | Evidence | Verified |
| --- | --- | --- | --- |
| `oauth_apps` model, secret shown once on create **and rotation** | MET | `migration 039`; rotation invalidates the old secret | RAN |
| PKCE challenge/method recorded; mismatched verifier → 400 `invalid_grant` | MET | `oauth-pkce.spec.ts` mandatory negative | CITED |
| Device Grant: user_code + device_code, `slow_down` honored | MET | `oauth/routes.test.ts`; **live prod issues `user_code`, `interval:5`, `expires_in:900`** | LIVE + RAN |
| Scope Registry — 7 scopes as data, register at module load | MET | `scopes/registry.ts`; typo'd scope is a boot failure, not a silent 403 | RAN |
| Token middleware populates app/user/scopes; 401 / 403-with-name | MET | `middleware/authn.test.ts` | RAN |
| One-time refresh tokens; reuse invalidates the family | MET | `drills/refresh-rotation.drill.test.ts` — asserts already-minted access tokens die too | RAN |
| Public routes only at `/api/v1/*`; lint rule fails the build on cross-import | MET | `eslint.config.mjs:97,117` `no-restricted-imports` at **error**; verified non-vacuously by planting an import | RAN — lint 0 errors |
| Consistent error shape, fitness-verified | MET | `contract.fitness.test.ts` | RAN |
| Cursor pagination `{data,next_cursor}`, stable across reordering | MET | Opaque base64 over `{id,timestamp}`; stability is discovery #2 | RAN |

### Webhooks — signing, retries, replay (7)

| Requirement | Status | Evidence | Verified |
| --- | --- | --- | --- |
| Event registry as data, Zod schema per type | MET | `webhooks/events.ts` | RAN |
| `IEventBus`; domain layer publishes, never the route layer | MET | `webhooks/bus.ts` | RAN |
| Per-app per-event subscriptions via `/api/v1/webhooks` (`webhooks:manage`) | MET | `platform/webhooks/` | RAN |
| HMAC-SHA256 `Ship-Signature: t=…,v1=…`; SDK rejects >5 min | MET | `signature.ts`; **all three clients of the contract now derive `sha256(secret)`** — see the 2026-08-16 fix | RAN — cli 76, slack 64 |
| Retry 1s/4s/16s/1m/5m/30m with jitter; 4xx permanent | MET | `deliverer.test.ts` — injected clock, zero sleeps | RAN |
| 6 failures → DLQ in the portal; manual replay carries the original key | MET | `drills/idempotency.drill.test.ts` + dedupe-disabled control | RAN |
| `webhook_deliveries` log; `/replay` re-emits with `Idempotency-Key` | MET | `replay_of_id` asserted | RAN |

### SDK, rate limiting, developer portal (8)

| Requirement | Status | Evidence | Verified |
| --- | --- | --- | --- |
| Resource clients documents/issues/sprints/webhooks; drift fails CI | MET | `sdk-parity.test.ts` — both directions, plus "guards against a vacuous pass" | RAN |
| `authorizationCodeFlow()` / `deviceLogin()`; pluggable `ITokenStore` | MET | in-memory, file, localStorage stores | RAN |
| Async-iterator pagination; consumer never sees cursors | MET | `sdk-live.test.ts` walks 7 rows | RAN |
| `verifyWebhook()` one call; tampered / expired / missing-v1 fail | MET | `sdk/src/webhook.test.ts` signs with the derived key — a real contract test | RAN — sdk 82 |
| Typed discriminated error union | MET | `kind: auth\|rate_limit\|not_found\|validation\|server` | RAN |
| Per-app and per-token token buckets; `X-RateLimit-*`; `Retry-After` on 429 | MET | `bucket.ts:86` never-zero guard; `middleware.test.ts:114`. **Boundary:** headers appear on *authenticated* responses; an unauthenticated 401 carries none because limits are per-app/per-token and authn precedes the limiter (`router.ts:9`) — confirmed live | LIVE + RAN |
| Public audit trail queryable in the portal | MET | `platform/audit/` | RAN |
| Dev portal: list/register apps, rotate secret, subscriptions, delivery log, replay | MET | `pages/devportal/`; `e2e/devportal-replay.spec.ts` is the first test to drive the portal, and it caught the Replay button returning **400 `app_id is required`** on every click. Fixed and asserted end-to-end | RAN |

---

## C. Terraform & infrastructure (4)

| Requirement | Status | Evidence | Verified |
| --- | --- | --- | --- |
| `terraform/` topology; all versions pinned; plan runs clean | MET | `versions.tf` — provider `1.9.1`, `required_version >= 1.6.0` | RAN |
| IAM least-privilege: Admin → minimal, service works, out-of-policy denied, before/after with rationale | **OWED** | `docs/week6-iam-least-privilege.md` — policy, per-permission rationale and verify commands drafted | OPEN — apply is owner-run |
| Drift demo; destroy then apply from scratch; proof it came back | MET | Live drift run 2026-08-14 (`evidence/2026-08-14/c3-drill/`, four phases); `terraform/render/out/13`,`14` | CITED |
| Read a modified plan at the defense (inability = auto-fail) | MET | Defense held Mon 2026-08-11; `docs/defense-week6-terraform-map.md` | CITED |

---

## D. Testing scenarios 2–9 (the brief numbers them from 2)

| # | Scenario | Status | Evidence | Verified |
| --- | --- | --- | --- | --- |
| 2 | PKCE in Playwright from a registered app; wrong verifier → `invalid_grant` **(mandatory)** | MET | `oauth-pkce.spec.ts` (8) | CITED |
| 3 | Device flow from a test CLI; `slow_down`; token works on `/api/v1/me` | MET | `oauth/routes.test.ts` end-to-end; prod receipt-backed for the pre-approval half | RAN + LIVE |
| 4 | Fitness test over every route: OpenAPI entry, scope, ApiError, pagination | MET | `contract.fitness.test.ts` — walks the live Express stack; verified by planting a rogue route | RAN |
| 5 | Validate spec against OpenAPI 3.1 schema; every spec method has a typed SDK call | MET | `$ref` resolution + `sdk-parity.test.ts` both directions | RAN |
| 6 | Subscribe via SDK → create doc → signed POST < 2s → SDK verifies → tampered rejected | MET | `platform/webhooks/*.test.ts` (84) | RAN |
| 7 | 500×3 then 200; waits ≥1s/4s/16s; 4th records success | MET | `deliverer.test.ts`, injected clock | RAN |
| 8 | 6 failures → DLQ in portal → **click Replay** → succeeds with original key | MET | `e2e/devportal-replay.spec.ts` clicks the real button; asserts the DB wrote exactly one replay row carrying the ORIGINAL idempotency key, then that the portal renders the chain. Found and fixed a live 400 in the process | RAN |
| 9 | TTFE drill end-to-end from a clean container, <30 min human / <60 s CI | MET | `drill ttfe` green against live prod in CI (#68), ~1.4 s | CITED |

---

## E. Performance targets (7)

| Metric | Target | Result | Verified |
| --- | --- | --- | --- |
| TTFE | ≤30 min; CI <60 s | ~1.4–2 s in CI against prod | CITED |
| PKCE round-trip P95 | <3 s | 8-spec file completes in 18.4 s serial | CITED |
| OpenAPI spec parity | 100% | `sdk-parity.test.ts`, zero drift | RAN |
| Webhook delivery P95 (first attempt) | <2 s | 573 ms measured | CITED |
| Retry success after transient 5xx | 100% | `deliverer.test.ts` | RAN |
| Rate-limit headers on public responses | 100% | **MET.** Middleware emission unit-tested; `Retry-After` never-zero guarded. The live `c7` probe was **unauthenticated and so could never pass** — the brief's own wording ("**per-app and per-token** token-bucket limits") means a request with no identity has no bucket, and 401s before the limiter runs. Fixed 2026-08-16: `c7` now mints a client-credentials token first, and records SKIPPED rather than MISSING when no secret is available. The check was wrong, not the API | RAN |
| Telemetry vs Part-1 baseline | ≤+10% P95 / bundle / queries | All five query flows −7.0% to −32.8%; bundle +1.21%/+2.43%; P95 −41% to −79% | RAN |
| SDK install size | <250 KB | 14.3 KB gzip | RAN |
| Drill flake rate | 0% over 20 CI runs | **ACCRUING** — needs 20 pushes | OPEN |

---

## F. Signature challenge — required capabilities (4)

| Capability | Status | Evidence | Verified |
| --- | --- | --- | --- |
| `drill ttfe` runs the full loop against a containerized Ship from a clean dir | MET | `integrations/cli/drill/ttfe.ts` | RAN |
| Per-stage timing in ms (install, login, subscribe, create, receive, verify) | MET | install 1 · login 30 · subscribe 7 · create 3 · receive 573 · verify 1 | CITED |
| One-line SDK verification; tampered/expired fail | MET | `verifyWebhook()` | RAN |
| **Drill runs in CI on every PR**; regression past threshold fails build | **MET** | Closed 2026-08-16 by **adding** a job, not deleting a gate: `drill-pr` (`if: github.event_name == 'pull_request'`) boots Ship from the PR's own build against a `postgres:16` service and drills it — same binary, same 60 s threshold, same non-zero exit. `verify-deployment` keeps its `main` gate because it targets live prod | RAN — YAML validated, 11 steps |

---

## G. Integrations — "at least 5 of 7" (5 shipped)

| Pick | Status | Evidence | Verified |
| --- | --- | --- | --- |
| CLI with device flow (**must-ship**) | MET | `integrations/cli/`, **76 tests green** | RAN |
| Slack — signed webhooks → channel posts | MET (install flow unexercised vs real Slack) | `integrations/slack/`, **64 tests green** — 18 were failing under a green claim until 2026-08-16 | RAN |
| Refresh-token rotation drill | MET | `refresh-rotation.drill.test.ts` | RAN |
| Idempotency-Key end-to-end drill | MET | `idempotency.drill.test.ts` + control | RAN |
| Browser SDK demo (PKCE SPA) | MET (built, never browser-driven) | `integrations/browser-demo/` | OPEN |
| *GitHub integration* · *plugin runtime* | Not selected — the brief requires 5 of 7 | — | — |

---

## H. Submission deliverables (9)

| Deliverable | Status | Evidence |
| --- | --- | --- |
| Public GitHub repo; per-slice branches; **PR lists criterion + fitness confirmation** | PARTIAL | Public; **five** branches on the mirror. No PR descriptions — work landed as described commits |
| Demo video 3–5 min | **OWED** | Script ready (`demo-script-week6.md`); recording is the owner's |
| Pre-Search, 3 phases + **saved AI conversation attached** | MET | `PRESEARCH-W6.md` (three phases, written 2026-08-10 before any Week-6 code) + the session that produced it, `docs/presearch-week6-ai-session.md` — committed 2026-08-16. It had always existed; it lived in `.claude/plans/`, outside the repo, so the citation resolved to nothing for anyone but the author |
| Architecture doc, 9 named sections | MET | `docs/architecture.md` |
| OpenAPI live + static copy | MET | Live 3.1.0, 11 paths / 13 ops; `docs/openapi.json` |
| AI cost analysis with the 3 named assumptions | MET | `docs/week6-cost-analysis.md` |
| Per-epic write-up; **E7's proof = agent audit-log rows from OAuth auth** | **MET** | E1–E6 met, E6's proof delivered. **E7's proof captured 2026-08-16** — `evidence/2026-08-16/epic7/agent-audit-rows.txt`: agent given a first-party OAuth identity, boot line flips `reads via pool` → `reads via sdk`, and `public_audit_log` records its own `client_id` on `GET /api/v1/issues` (`issues:read`) ×20 and `GET /api/v1/me` ×1, all 200 — rows impossible while it held a `pg.Pool`. **Caveat:** local stack; wiring the same three vars into `terraform/render/` so *production* runs the SDK path is not applied |
| Three discoveries | MET | `docs/week6-discoveries.md` |
| Deployed app + grader app + README credentials | MET | Verified live; note the grader path is the **device flow** — `client_credentials` is correctly restricted to first-party apps |
| Social post tagging @GauntletAI with the `webhooks tail` screenshot | **OWED** | Two drafts ready |

---

## I. Critical guidance (6)

| Rule | Status | Evidence | Verified |
| --- | --- | --- | --- |
| Public/internal split enforced by lint from day 1 | MET | `eslint.config.mjs`, error severity, added before any cross-import existed | RAN |
| Generate the OpenAPI spec, never write it | MET | Route factory; `docs/openapi.json` is a build artifact | RAN |
| Deterministic clock injection — never `setTimeout` waits | MET | Zero sleeps in any webhook test | RAN |
| One LLM call per agent turn; platform never invokes the LLM | MET | Platform is LLM-free | — |
| `integrations/` imports only `@ship/sdk` | MET | Lint rule verified non-vacuously | RAN |
| TTFE drill in CI from Day 5 | MET | Every push to `main`, plus every PR since 2026-08-16 (`drill-pr`) | RAN |

---

## J. Interface Definitions (p.6)

Added 2026-08-16. This block had **zero rows** until then — and a block with no rows
can never come back MISSING, because nothing asks about it. That is the same failure
shape as the gate this document exists to close, so it is recorded rather than quietly
backfilled. Every item was satisfied; the trace was what was short, not the product.

| Brief specifies, verbatim | Code | Status | Verified |
| --- | --- | --- | --- |
| `code: "unauthorized" \| "forbidden" \| "not_found" \| "validation_failed" \| "rate_limited" \| "server_error"` | `api/src/platform/api/v1/errors.ts:17-24` — all six, plus `token_expired`, which MVP A3 separately requires as a distinct expiry code | MET | RAN |
| `message: string; details?: Record<string, unknown>; request_id: string` | same file; the fitness test asserts the exact key set on every route | MET | RAN |
| `class ShipClient { readonly documents; issues; sprints; webhooks }` | `sdk/src/client.ts:91-100` — all four, resource-segregated (the brief's ISP note) | MET | RAN |
| `static async deviceLogin(opts): Promise<ShipClient>` | `client.ts:153` — static, async, returns `ShipClient` | MET | RAN |
| `onUserCode: (code: string, verifyUrl: string) => void` | `client.ts:45` — signature identical, both parameters | MET | RAN |
| `verifyWebhook(headers, rawBody, secret, toleranceSec?) // default 300` | `sdk/src/webhook.ts` — 300 s default; tampered / expired / missing-`v1` all fail | MET | RAN |

## K. Evaluation Criteria — drill stages to expected outcomes (p.7)

Also unrowed until 2026-08-16.

| Stage | Expected outcome (brief) | Status | Verified |
| --- | --- | --- | --- |
| Install | Workspace package resolves; types load; no peer-dep errors | MET | RAN — zero runtime deps |
| Auth (`ship login`, device flow) | User code displayed; polling succeeds within 60 s; token persists | MET | RAN — `oauth/routes.test.ts`; live prod issues a user code |
| Subscribe | Subscription persisted; signing secret returned once; **appears in dev portal** | MET | RAN — portal surface now covered by `devportal-replay.spec.ts` |
| Trigger | Document created; `document.created` published; subscribers receive POST | MET | RAN — 84 webhook tests |
| Verify | Valid passes; tampered fails; >5 min fails | MET | RAN — sdk 82 |
| Total | < 60 s in CI | MET | CITED — ~1.4 s, CI #68 |

---

## A citation is only evidence if the grader can open it

`evidence/` is gitignored (`.gitignore:49`); its files are in the repo only because
they were force-added. 21 are tracked. **Seven cited files are on disk but not in
git**, so a grader cloning the repo hits a dead citation:

| Path | Cited for | State |
| --- | --- | --- |
| `evidence/2026-08-12/results.json` | D3 device flow, `c7` rate-limit | on disk, untracked |
| `evidence/2026-08-12/c1…c5_*.png` (5 files) | live-walk screenshots | on disk, untracked |
| `evidence/2026-08-16/e2e-full-single-worker-SUMMARY.txt` | A9 regression clause | on disk, untracked |

The same class of defect closed the Pre-Search row: its artifact lived in `.claude/plans/`,
outside the repo entirely. **A path only the author can open is not a citation.**

Fix before the submission commit:

```bash
git add -f evidence/2026-08-12 evidence/2026-08-16
```

Every other cited path was checked and **is** tracked — verified by resolving each
`evidence/...` string in this file, the ledger and the submission index against
`git ls-files`.

## Open items, consolidated

**OWED — only the owner can close (3).** Demo video · social post + screenshot ·
C2's IAM apply against the real AWS identity.

*(The Pre-Search transcript left this list on 2026-08-16 — it was never actually
missing. The artifact existed from 2026-08-10 but lived outside the repo, so the
citation resolved to nothing for a grader. Copied in, both clauses now MET.)*

**PARTIAL — stated, not hidden (2).** A9's regression clause (see below) and the
per-slice-PR clause, which can only be satisfied going forward: all four pre-existing
branches have **0 commits not in `main`**, so no PR can be opened from them. The work
done on 2026-08-16 ships as five separate slice branches, each with a PR description
naming its acceptance criterion and its fitness test.

**ACCRUING (1).** Drill flake rate over 20 CI runs — time, not effort.
