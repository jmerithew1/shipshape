# Week 6 — Demo Script (browser-only, ~4 min)

No terminal. Everything runs in a browser against the live deployment. Submitting
the MVP *as* the final, so this one video shows both: the platform is built and
works (MVP), and it's verified and CI-gated against the deployed system (final).

Live base URL: **https://ship-api-r1om.onrender.com**

---

## Setup (off camera, ~3 min)

1. In a browser, open a fresh **webhook.site** tab — it hands you a unique URL and
   shows every request it receives. Copy that URL. (This is the "subscriber".)
2. Open `https://ship-api-r1om.onrender.com` and **log in**: `demo@ship.local` /
   `demo1234`.
3. Go to `https://ship-api-r1om.onrender.com/devportal`:
   - **Apps** → *Register an app* → name it "Demo Integration", any redirect URI →
     it appears with a `client_id`.
   - **Subscriptions** → create one: event `document.created`, target URL = the
     **webhook.site URL** from step 1. (Copy the signing secret it shows once.)
4. Do a dry run: in the app, create a document → within a second the event lands
   on webhook.site and a row appears in the portal's **Deliveries** tab. Delete
   that doc so you start clean on camera.

*(Tabs to have open on camera: **App**, **webhook.site**, **/devportal**, and one
extra: the **green CI run** at github.com/jmerithew1/shipshape/actions.)*

---

## 🎥 Record — ~4 min

### Beat 1 — The product, then the platform (0:00–0:50)
**Show:** the app (`/`), logged in.
**Say:** "For five weeks, Ship was this — a documents-and-projects app. This week
it became a platform other people can build on."
**Show:** `/api-docs` (Swagger UI). Expand `POST /api/v1/webhooks`.
**Say:** "Here's the public, versioned API — and these docs are generated from the
routes themselves, so the contract can't drift from what the server does."

### Beat 2 — The developer console (0:50–1:40)
**Show:** `/devportal` → **Apps**.
**Say:** "This is where a developer sets up. They register an app and get a
client_id and a secret — shown exactly once, like Stripe."
**Show:** **Subscriptions** tab.
**Say:** "Then they subscribe to the events they care about — here, every time a
document is created."

### Beat 3 — The loop, live (1:40–3:00) — the payoff
**Show:** the app. Create a document — title it "hello".
**Say:** "Watch. I create a document…"
**Switch to:** the **webhook.site** tab.
**Say:** "…and there it is — Ship delivered a signed `document.created` event.
That `Ship-Signature` header is an HMAC of the payload with the subscription's
secret. A subscriber verifies it locally, so the signing key never travels."
**Switch to:** `/devportal` → **Deliveries**.
**Say:** "And the platform keeps the delivery log — status, attempts, latency.
Any delivery can be replayed with its original idempotency key."
**Do:** click **Replay** on the row → switch to webhook.site → the replay arrives.

### Beat 4 — Not staged: it's gated in CI (3:00–3:35)
**Show:** the green CI run tab.
**Say:** "And this isn't a one-off for the camera. That whole loop — log in,
subscribe, create, receive, verify — runs in CI against this live deployment on
**every push**. Over 60 seconds, or a bad signature, and the build goes red and
nothing ships. Here it is green."

### Beat 5 — MVP + final, one breath (3:35–4:00)
**Say:** "So that's the MVP: an OAuth 2.0 server, a public versioned API with one
error shape and cursor pagination, HMAC-signed webhooks with retries, a
dead-letter queue and replay, a typed SDK, a CLI, and this portal. And it's the
final bar too — everything you just saw is verified, tested, and gated in CI
against the deployed system. It works in production, on every push. That's the
platform."

*(Stop recording.)*

---

### If something doesn't appear
- **No delivery on webhook.site:** confirm the subscription's target URL is the
  exact webhook.site URL, and that prod is on the latest deploy
  (`/ready` shows the running commit). Give the deploy a couple of minutes.
- **Prefer one command instead?** `pnpm --filter @ship/cli drill ttfe` runs the
  whole loop in one shot (see git history) — but the browser flow above needs no
  terminal at all.
