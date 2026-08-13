# Week 6 — Social post

Format per the week-4 reviewer feedback: **hook → receipts → lesson**, one
post, tag @GauntletAI. Screenshot is the `ship webhooks tail` terminal showing
a verified signed event.

---

## Primary (recommended)

> I gave my AI agent a database handle in week 5. This week I took it away.
>
> It now authenticates as an OAuth app and reads through the same public API as
> a stranger — scoped, rate-limited, and audited. The proof isn't that it works.
> It's that its client_id shows up in the audit log.
>
> Week 6 of @GauntletAI: Ship became a platform.
> · OAuth 2.0 server — PKCE + device grant, refresh families that self-revoke on replay
> · /api/v1 with one error shape and an OpenAPI spec generated from the routes
> · Webhooks: retry ladder, DLQ, replay — all one Postgres table
> · A typed SDK: 14 KB gzipped, zero dependencies
>
> The thing I'll actually remember: I wrote a fitness test that walked my own
> route registry and called drift "structurally impossible." It was reading the
> list I maintained, not the server I shipped. A route mounted by hand was
> invisible to it. Now it walks the live Express stack — and I only believed it
> after planting a fake route and watching it fail.
>
> A test you've never seen fail is a hypothesis, not a gate.
>
> [screenshot: ship webhooks tail — document.created ✓ signature verified]

---

## Alternate — leads with the audit findings

> Three audits ran against my week-6 platform before it merged. They found 11
> defects. My favorite:
>
> A 429 on my public API returned `{error: "..."}` instead of my documented
> error envelope — while the OpenAPI spec I generate *promised* the envelope.
> My published contract was lying. No test could catch it: the test environment
> raises the rate limit so high a 429 is unprovokable.
>
> Also found: CSRF defeatable by a trailing slash. Cursor pagination that
> silently dropped rows edited mid-walk. X-RateLimit headers that were never
> actually sent.
>
> All fixed, each with a regression test. Week 6 @GauntletAI — Ship is a
> platform now: OAuth 2.0, /api/v1, signed webhooks with replay, a typed SDK,
> and an agent that goes through the front door.
>
> Audits are cheap. Finding out from a grader is not.
>
> [screenshot: ship webhooks tail — document.created ✓ signature verified]

---

## Notes for posting

- **Screenshot to capture:** run `ship webhooks tail` with a subscription
  active, create a document in another terminal, and grab the frame showing
  `listening for events…` followed by the event line and `✓ signature verified`.
- Primary post leads with the agent story (the week's actual architectural
  payoff) and closes on the discovery. The alternate leads with the audit
  findings — stronger if the feed rewards specificity over narrative.
- Both keep to one post. No thread.
- Repo link goes in the main post, per the week-4 owner call.
