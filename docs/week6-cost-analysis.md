# Week 6 — AI & Platform Cost Analysis

**The headline discipline: the platform itself does zero AI work.** No route
under `/api/v1`, no OAuth grant, no webhook delivery, and no SDK call invokes a
language model. The only LLM spend in this system is a user-initiated agent
turn, exactly as in Week 5. That is why platform cost scales with API traffic
and webhook fan-out, while LLM cost scales with agent activity — two
independent curves, and the expensive one is not the one the platform drives.

Epic 7 is the interesting case: the agent's *access path* changes (raw SQL →
SDK → public API) while its *cost shape* does not. Token volume per turn is
unchanged because prompts and model routing are untouched.

---

## 1. Development spend actually incurred

| Item | Measured | Notes |
| --- | --: | --- |
| LLM spend on agent work this week | **≈ $0.00** | The rewire touches the data-access seam, not prompts. Detector runs in tests use intent-keyed fakes (`api/src/fleetgraph/test-fakes.ts`), so no live model is called. |
| Week-5 baseline for comparison | ≈ $0.04 total | 94% of agent runs were zero-LLM (deterministic SQL detectors short-circuit before triage). Documented in `FLEETGRAPH.md`. |
| CI minutes | ~10–13 min per push | `checks` job: install → build (5 packages) → lint → type-check → migrate → api tests (660) → web tests (160) → sdk tests (81) → coverage. |
| OAuth Playwright browser launches | 8 tests, ~18 s serial / ~1.4 min at 8 workers | `e2e/oauth-pkce.spec.ts`. Each worker starts a Postgres testcontainer, which dominates the cost — not the browser. |
| OpenAPI generation + validation | < 1 s | In-process; the spec is built once and cached. Negligible, but measured rather than hand-waved. |
| Delivery-log storage during demos | ~1 KB/row | A drill run writes 5–10 rows. 20 CI runs/day ≈ 200 rows/day ≈ 200 KB/day. |

**Verifying the rewire does not change token volume.** The before/after
measurement is a LangSmith trace comparison on an identical detector scenario
with the flag off and on. Because the flag changes only where rows come from,
the expectation is identical token counts; a difference would mean the SDK path
is feeding the model different context, which is a bug, not a cost finding.

---

## 2. Production projections

Assumptions are stated first, because the projection bends entirely on them.

### Stated assumptions

**Webhook fan-out ratio — 2.5 deliveries per write.** Each write publishes one
event; the number of deliveries equals the number of active subscriptions
matching that event type. At demo scale we seed 2–3 subscriptions per event
type, so one `document.created` produces 2–3 signed POSTs. At larger tiers the
realistic distribution is a long tail: most events match 1–2 subscriptions, a
few popular event types match many. 2.5 is the blended figure used below.

**Agent active rate — 20% of users on a given day, 5 turns each.** This is the
assumption the LLM column is most sensitive to. It is *not* a platform-traffic
figure: an org can generate millions of API calls with almost no agent usage,
because the agent is one installed app among N. Halving this halves the LLM
cost and changes nothing else.

**Storage retention — delivery log 30 days, audit log 90 days.**
The delivery log is an operational debugging tool: after a month, a failed
webhook is not being investigated, it has been re-sent or abandoned. The audit
log is a security artifact — "did this app do that?" is asked long after the
fact, so it outlives the delivery log threefold. Rows are ~1 KB (delivery,
including the payload excerpt) and ~250 B (audit).

### Projections

| Tier | API calls/day | Webhook deliveries/day | Agent LLM calls/day | Est. cost/month |
| --- | --: | --: | --: | --: |
| 100 users | ~20,000 | ~5,000 | ~50 | **$2–8** |
| 1,000 users | ~200,000 | ~50,000 | ~500 | **$15–50** |
| 10,000 users | ~2,000,000 | ~500,000 | ~5,000 | **$80–250** |
| 100,000 users | ~20,000,000 | ~5,000,000 | ~50,000 | **$500–1,500** |

**Storage at each tier** (delivery log at 30 d × 1 KB, audit at 90 d × 250 B):

| Tier | Delivery log | Audit log | Total |
| --- | --: | --: | --: |
| 100 users | ~150 MB | ~450 MB | ~0.6 GB |
| 1,000 users | ~1.5 GB | ~4.5 GB | ~6 GB |
| 10,000 users | ~15 GB | ~45 GB | ~60 GB |
| 100,000 users | ~150 GB | ~450 GB | ~600 GB |

At 100k users storage, not compute, is the line item that demands attention —
which is the argument for the retention windows above rather than keeping
everything.

---

## 3. Where the cost curve actually bends

**Not the LLM.** At every tier, agent LLM spend is a minority of the total, and
it is bounded by human activity — one call per agent turn, and turns require a
person. It cannot run away on its own.

**The webhook deliverer is the first thing that breaks.** A single in-process
poller saturates around ~50 deliveries/second (connection-bound). The 10,000-user
tier averages ~6/s, so headroom is real but not infinite, and traffic is bursty.
That knee is precisely why `IWebhookDeliverer` exists as an interface: the
queue-backed implementation is a drop-in, not a rewrite.

**Runaway protection is structural, not a budget alert.** A subscriber that
5xx's forever cannot cost unbounded money: deliveries are capped at 6 attempts
(~37 minutes of ladder) and then dead-lettered. There is no infinite retry, so
the worst case for one broken subscriber is 6 requests per event, not a loop.

**In-memory rate limiting is correct today and a cost risk later.** Buckets
reset on deploy and are per-instance. On one Render instance that is exactly
right. At multi-instance scale it becomes N× the intended limit, which is a
correctness problem before it is a cost problem — the documented Redis swap.

---

## 4. What this analysis does not cover

- **No measured production traffic.** Ship has no real users; every figure above
  is a projection from a stated model, not an observation. The dev-spend numbers
  in §1 are measured; §2 is arithmetic on assumptions.
- **Egress** is excluded — Render's included bandwidth covers demo volume, and
  webhook payloads are thin (ids, not document content).
- **Cost per model call** uses Week-5's observed mix (Haiku for triage, Sonnet
  for chat). A routing change would move the LLM column and nothing else.
