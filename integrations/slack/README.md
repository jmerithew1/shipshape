# `@ship/slack` — Slack integration

Receives signed Ship webhooks and posts `document.created` and `issue.assigned`
into a Slack channel. Installed into a workspace via Slack OAuth.

Like every package under `integrations/`, this one talks to Ship **only through
`@ship/sdk`**. It cannot import `api/src`; ESLint's `no-restricted-imports` rule
fails the build if it tries. That constraint is the point: this integration is a
platform citizen, built against the same public surface a third party gets, so
if the public contract is insufficient it fails here first rather than in
someone else's repo.

---

## Run it

```bash
pnpm install
pnpm --filter @ship/slack build
SHIP_WEBHOOK_SECRET=whsec_... pnpm --filter @ship/slack start
# → [ship] Slack integration listening on :3210/webhooks/ship
# → [ship] DRY RUN — set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID ... to post for real.
```

Endpoints:

| Method | Path                    | Purpose                                     |
| ------ | ----------------------- | ------------------------------------------- |
| `POST` | `/webhooks/ship`        | The receiver. Point your subscription here. |
| `GET`  | `/healthz`              | Liveness + whether it is in dry-run mode.   |
| `GET`  | `/slack/install`        | Start the Slack OAuth install.              |
| `GET`  | `/slack/oauth/callback` | Slack redirects here with `?code&state`.    |

The OAuth routes are only mounted when `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
and `SLACK_REDIRECT_URI` are all set. Without them you get the receiver alone,
which is the right shape for a single-workspace deploy using a pasted bot token.

---

## Environment

| Variable                | Required            | What it does                                                        |
| ----------------------- | ------------------- | ------------------------------------------------------------------- |
| `SHIP_WEBHOOK_SECRET`   | **yes**             | Subscription signing secret. Printed **once** by `ship webhooks create`. |
| `PORT`                  | no (`3210`)         | Listen port.                                                        |
| `SLACK_BOT_TOKEN`       | no                  | `xoxb-…`. Omit for dry run, or let OAuth supply it.                 |
| `SLACK_CHANNEL_ID`      | no                  | e.g. `C0123ABCD`. Omit for dry run.                                 |
| `SLACK_CLIENT_ID`       | only for OAuth      | From the Slack app's Basic Information page.                        |
| `SLACK_CLIENT_SECRET`   | only for OAuth      | Same page. Never goes in a query string.                            |
| `SLACK_REDIRECT_URI`    | only for OAuth      | Must byte-match the Redirect URL in the Slack app manifest.         |
| `SLACK_INSTALL_STORE`   | no                  | Path to a JSON file for installations. In-memory when unset.        |

`SHIP_WEBHOOK_SECRET` is the only hard requirement — a receiver that cannot
verify has no business accepting anything.

---

## Dry-run mode

With `SLACK_BOT_TOKEN` or `SLACK_CHANNEL_ID` unset, the integration logs the
exact JSON body it *would* have sent to `chat.postMessage` and treats the post as
successful:

```
[slack:dry-run] POST https://slack.com/api/chat.postMessage {"channel":"#dry-run","text":"📄 New document: *Q4 launch plan* (`4444…`)"}
```

Everything else is real — real signature verification, real dedupe, real
formatting, real status codes. Only the HTTPS call to Slack is skipped. This
exists so the integration is demonstrable end to end on a machine with no Slack
workspace attached, which is the common case for a reviewer.

---

## Pointing a Ship subscription at it

```bash
ship webhooks create \
  --event document.created \
  --url https://<your-public-host>/webhooks/ship
# → prints the signing secret. This is the ONLY time it is shown.
```

Repeat for `issue.assigned` (or subscribe to more event types — anything this
integration does not render is answered `200 {"status":"ignored"}`, never a 4xx).

**A receiver on your laptop has no public address**, so Ship cannot POST to it.
Two options:

1. **A tunnel** — `ngrok http 3210`, `cloudflared tunnel --url http://localhost:3210`,
   or any deploy with a public hostname. Use the tunnel's HTTPS URL in
   `--url`. This is the only way to exercise the real inbound path.
2. **`ship webhooks tail`** — the CLI's delivery inspector. Note what it is:
   a **poll** of the delivery log that verifies each `Ship-Signature` locally.
   It is not a relay and does not forward anything into this receiver. Use it to
   confirm Ship is *sending* what you expect; use a tunnel to confirm this
   receiver *handles* it.

For a local end-to-end check with no tunnel and no Ship instance, sign a body
yourself — HMAC-SHA256 over `` `${t}.${rawBody}` `` with the secret, sent as
`Ship-Signature: t=<unix>,v1=<hex>`. `src/server.test.ts` has this in ten lines.

---

## What it posts

| Event              | Message                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `document.created` | `📄 New document: *<title>* (` `` `<document_id>` `` `)`          |
| `issue.assigned`   | `🎫 #<ticket_number> *<title>* assigned to ` `` `<assignee_id>` `` |

Payloads from Ship are thin by design — ids plus a display field. If you need the
document body, issue a `GET` with your **own** scoped token; the read is then
authorized at read time and shows up in the audit log under your client id.

Titles are escaped before they reach Slack. A document titled `<!channel>` would
otherwise notify everyone in the room, and that title is written by a user in
someone else's workspace.

---

## Status codes, and why each one

Ship reads the response status as a routing decision:

- **2xx** → delivered, never retried.
- **4xx** → **permanent**. Dead-lettered immediately, zero retries.
- **5xx** → transient. Retried on the backoff ladder.

So:

| Situation                                    | Status | Why                                                                                        |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| Posted to Slack                              | `200`  | Done.                                                                                        |
| Duplicate idempotency key                    | `200`  | Already handled. Retrying is not wanted.                                                     |
| Event type we do not render                  | `200`  | Filtering locally is normal. A 4xx would dead-letter events the operator may want later.     |
| Slack slow, post still in flight             | `202`  | Ack fast so Ship does not time out and retry; the claim is held so no second message posts. |
| Bad / missing / expired signature            | `401`  | Permanent — the same bytes fail identically forever. Retrying would let a junk POST become sustained load on Ship's delivery workers. |
| Body is not JSON, or not an event envelope   | `400`  | Permanent, same reasoning.                                                                   |
| Slack permanently refuses (`invalid_auth`, `channel_not_found`) | `422` | Permanent. One dead letter carrying the real Slack error code beats six identical failures spread over an hour. |
| Slack unreachable, 5xx, or rate limited      | `502`  | Transient. The event is recoverable; dead-lettering it on a blip means a human has to find and replay it. |

An unrecognised Slack error code defaults to **transient**. A few wasted retries
cost less than a message dropped because Slack shipped an error string this
integration has not heard of.

---

## The three things a subscriber usually gets wrong

**1. Verifying a re-serialized body.** The HMAC covers the exact bytes Ship sent.
`express.json()` parses them and throws them away; `JSON.stringify(req.body)`
then produces a *different* string — different key order, no original
whitespace, `1.0` collapsed to `1`. One byte off is a completely different
digest, so perfectly valid deliveries return 401 and you spend an afternoon
suspecting the secret. This receiver uses `express.raw({ type: 'application/json' })`
and verifies before anything parses.

**2. Not deduping.** Delivery is at-least-once, and a manual replay reuses the
*original* `Ship-Idempotency-Key` (it is derived from the event id, not the
attempt). A receiver that posts on every request double-posts — and it does so
precisely on retry paths, i.e. when things are already going badly.

The key is **claimed** before the Slack post and **released** if the post failed
transiently, so a retry can still succeed. Marking on arrival instead would turn
"Slack was briefly down" into "the message is lost forever".

Storage is an in-memory bounded LRU (5000 keys). It survives neither a restart
nor a second replica, so a redeploy mid-retry can produce one duplicate message.
A production subscriber persists this — Redis `SET key NX EX 86400`, or a unique
index on the idempotency key — retaining entries at least as long as Ship's
retry ladder runs.

**3. Inverting the status contract.** See the table above. Both directions are
real bugs: 5xx on a bad signature is an infinite retry of a hopeless delivery;
4xx on a Slack blip throws away a recoverable event.

---

## Slack OAuth

`GET /slack/install` mints a single-use, TTL-bounded `state` and redirects to
`https://slack.com/oauth/v2/authorize` with `chat:write` and
`chat:write.public`. `GET /slack/oauth/callback` validates the state **before**
touching the code, exchanges it at `oauth.v2.access` (form-encoded, secret in
the body — query strings land in access logs), stores the bot token, and swaps
it into the live poster.

State is the CSRF defence, not decoration: without it an attacker sends an admin
a crafted callback carrying the *attacker's* code, and this integration ends up
posting your workspace's document titles into a Slack the attacker controls. A
callback whose state was not issued here never reaches Slack's token endpoint.

**Storage:** `MemoryInstallationStore` by default, `FileInstallationStore` (JSON,
mode 0600) when `SLACK_INSTALL_STORE` is set. Both are placeholders and say so —
a bot token is a bearer credential for someone else's Slack. Production belongs
in a secrets manager, or at minimum a database column encrypted with a KMS data
key. That is the first thing to replace.

**Status:** the flow is implemented and unit-tested against a fake Slack (happy
path, forged state, replayed state, expired state, cancelled install, refused
exchange, unreachable Slack, and that the token is never echoed to the browser).
It has **not** been run against real Slack — no Slack app was created for this
environment. Every byte on the wire is asserted in `src/oauth.test.ts`, but
treat "works against slack.com" as unverified until someone completes an install.

---

## Why `fetch` and not `@slack/web-api`

Two endpoints are used: `chat.postMessage` and `oauth.v2.access`. Both are
ordinary HTTPS POSTs with a two-field contract (`ok`, `error`). The official
client would add a dependency tree to save about fifteen lines, and it would
obscure the one thing that has to be exactly right — the mapping from a Slack
failure to transient-vs-permanent, which decides whether Ship retries or
dead-letters. `@ship/sdk` is zero-dependency for the same reason. The only
runtime dependencies here are `express` and `@ship/sdk`.

One trap worth naming: **Slack answers `chat.postMessage` with HTTP 200 and
`{ "ok": false }`** for most application-level failures. Checking `res.ok` alone
means believing every message was delivered. Both the status line and the body
are checked.

---

## Tests

```bash
pnpm --filter @ship/slack test          # 55 tests
pnpm --filter @ship/slack exec tsc --noEmit
pnpm exec eslint integrations           # the boundary gate
```

No test reaches the network. Slack is always a spy or a fake `fetch`. The
receiver tests *do* bind a loopback port on an ephemeral port number, because
the property most worth proving — that the bytes which were signed are the bytes
that get verified — only holds if the real Express body pipeline runs. Faking
`req` would fake away the bug.

Two tests deserve calling out:

- **Tampered body → 401 and the Slack spy has zero calls.** The assertion is on
  the spy, not just the status code. A 401 with a Slack post already sent would
  be a security failure that a status-only assertion happily passes.
- **The dedupe control.** Replaying one delivery twice must produce exactly one
  Slack post — and the *same two requests* with dedupe disabled must produce
  two. Without the control the passing test would also pass if the harness
  quietly sent one request.
