# Week 6 — Demo Script (3–5 min)

The assignment names the demo outright: *"The five-line story is the demo."*
So the video is that loop, then the portal replay. Nothing else.

**Setup before recording** (do this off-camera):
- Terminal font large enough to read at 720p.
- `pnpm --filter @ship/sdk build && pnpm --filter @ship/cli build` already done.
- A workspace with a few documents so the list isn't empty.
- Portal open in a browser tab at `/devportal`, already logged in.
- Two terminals side by side: **left** for commands, **right** for `webhooks tail`.

---

## Beat 1 — The claim (0:00–0:20)

**Say:** "Ship has been an app for five weeks. This week it became a platform.
The test isn't how many endpoints I shipped — it's whether a stranger can go
from nothing to a verified signed webhook. That's the whole demo."

**Show:** the deployed OpenAPI spec in a browser tab —
`https://ship-api-r1om.onrender.com/api/v1/openapi.json`. Scroll once.

**Say:** "That spec is generated from the routes. I don't write it, so it can't
lie."

---

## Beat 2 — Log in from a terminal (0:20–1:00)

**Left terminal:**
```bash
ship login
```

**Say while it prints the code:** "This is the device flow — the same one a TV
or a CLI uses, because a terminal has no browser to redirect back to. It shows
me a code, I approve it as a human, and the CLI polls until it's authorized."

**Show:** approve the code in the browser. Come back to the terminal.

**Point at the confirmation line:** "It tells me it worked. A login that
prints nothing and hangs is indistinguishable from a broken one."

---

## Beat 3 — Start the tail (1:00–1:20)

**Right terminal:**
```bash
ship webhooks tail
```

**Say:** "It prints *listening* immediately — before any event exists — so I
know it's alive. Now it's waiting."

*(This is the moment worth getting right on camera: the tail must be visibly
idle before anything happens, or the payoff in beat 4 reads as a coincidence.)*

---

## Beat 4 — The payoff (1:20–2:10)

**Left terminal:**
```bash
ship docs create --title "hello"
```

**Say:** "That went through the SDK, to the public API, with a scoped OAuth
token."

**Point at the right terminal** as the delivery lands:

**Say:** "And there it is — `document.created`, and *signature verified*. Ship
signed that payload with the subscription's secret, and the CLI checked it
locally. The verification key never left my machine. That's the same trust
model as `stripe listen`."

**Say (the line that matters):** "That's the loop. Install, log in, create,
verified event. Under 30 minutes for a stranger — and it runs in CI on every
pull request in under a minute, so it can't silently break."

---

## Beat 5 — Replay in the portal (2:10–3:00)

**Switch to the browser, `/devportal`.**

**Show:** the delivery log — event type, status, attempt number, latency.

**Say:** "Every delivery attempt is recorded. When a subscriber says 'we never
got it,' this is the answer — with a status code and a latency, not a shrug."

**Show:** a dead-lettered delivery. Click **Replay**.

**Say:** "Six failures and it dead-letters instead of retrying forever. An
operator replays it — and the replay carries the *original* idempotency key,
so a subscriber that dedupes correctly processes it exactly once. At-least-once
delivery is the contract; the key is how subscribers survive it."

---

## Beat 6 — The agent walks in the front door (3:00–3:50)

**Show:** the audit log tab in the portal, filtered to the agent's `client_id`.

**Say:** "Last week my agent had a database handle. It saw everything, nothing
limited it, and nothing recorded it. This week it authenticates as an OAuth app
and reads through the same public API as a stranger — scoped, rate-limited,
audited."

**Point at the rows:** "These rows are the proof. Not that it works — that it's
*accountable*. If my own agent needed a backstage pass to be useful, I wouldn't
have built a platform. I'd have built an app with an API bolted on."

---

## Beat 7 — Close (3:50–4:15)

**Say:** "One error shape on every failure, with a request id that ties a
client-side error to its audit row. A spec generated from the routes. An SDK
that's 14 kilobytes with zero dependencies. And a webhook system that's one
Postgres table — because the retry ladder forces durable storage anyway, so
the storage *is* the queue."

**Say (last line):** "Three audits ran against this before it merged. They
found eleven defects, including a 429 that returned the wrong shape while my
own spec promised the right one. All fixed, each with a regression test. That's
the part I'd want you to look at."

---

## If something breaks on camera

- **`tail` shows nothing:** the subscription may point at a stale URL. Fall
  back to the portal's delivery log — the delivery is recorded either way, and
  `signed_body` + `signature_header` are stored so verification still
  demonstrates from the log.
- **Device approval times out:** codes expire in 15 minutes. Re-run
  `ship login`; don't fight it on camera.
- **Deployed instance is cold:** Render Starter can take a few seconds on first
  hit. Warm it with a `curl /health` before recording.
- **Anything else:** say what you expected, say what happened, move on. A demo
  that acknowledges a failure reads better than one that pretends.

---

## Recording checklist

- [ ] Terminal font ≥ 18pt, dark theme, both terminals visible
- [ ] Warm the deployed instance
- [ ] Confirm the subscription is active before starting
- [ ] Record beat 3 and 4 in one unbroken take (idle tail → event arriving)
- [ ] 3–5 minutes total; if over, cut beat 7's first paragraph
- [ ] Screenshot the verified-event frame for the social post while you're here
