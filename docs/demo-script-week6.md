# Week 6 — Demo Script (simple, ~3–4 min)

Submitting the MVP *as* the final, so this one video shows both: the platform is
**built and works** (MVP), and every claim is **verified, tested, and gated in
CI against the live deployment** (final). Three reliable beats, nothing fragile.

---

## Setup (off camera, ~2 min)

1. Big terminal font (readable at 720p).
2. Build the client once:
   ```bash
   pnpm --filter @ship/sdk build && pnpm --filter @ship/cli build
   ```
3. Export the drill credentials so the on-camera command stays clean (these are
   the *published* grader credentials):
   ```bash
   export SHIP_CLIENT_ID=ship_app_ttfe_drill
   export SHIP_CLIENT_SECRET=ship_sec_bd48273402dbb7560d7a8f47d7cea4c95b0836743e108117ca9ef6adf88f9e80
   ```
4. Open two browser tabs:
   - **Live spec:** `https://ship-api-r1om.onrender.com/api/v1/openapi.json`
   - **Green CI run:** GitHub → repo → **Actions** → the newest green run.

---

## Beat 1 — The claim + the live contract (0:00–0:40)

**Say:** "For five weeks Ship was an app. This week it became a platform anyone
can build on. The real test isn't how many endpoints I shipped — it's whether a
stranger can go from nothing to a *verified, signed webhook*. Let me show you
that, live."

**Show:** the `openapi.json` tab. Scroll once.

**Say:** "This OpenAPI spec is generated from the routes themselves — I never
hand-write it, so the published contract can't drift from what the server
actually does."

---

## Beat 2 — The whole loop, one command (0:40–2:00)

**Say:** "Here's the entire platform in one command — the Time-To-First-Event
drill. From a clean checkout it logs in with OAuth, subscribes to an event,
creates a document, receives the signed delivery, and verifies the signature —
the exact path a real integrator walks."

**Run:**
```bash
pnpm --filter @ship/cli drill ttfe
```

**Narrate as the table prints:** "Login. Subscribe to `document.created`. Create
a doc. The event fires, the delivery lands, and — *signature verified*. Ship
signed it with the subscription's secret; the SDK checked it locally, so the
signing key never left this machine. About a second and a half — against the
**live deployed API**, not a mock."

---

## Beat 3 — It's real, and it's not staged (2:00–2:40)

**Show:** the green Actions run tab.

**Say:** "And this isn't a one-off I got working for the camera. That exact drill
runs in CI against the live production deployment on **every push** — if first
event ever takes longer than 60 seconds, or a signature fails to verify, the
build goes red and nothing ships. Here's a green run: checks, deploy, and the
live drill, all passing."

---

## Beat 4 — MVP + final, in one breath (2:40–3:10)

**Say:** "So that's the MVP: a real OAuth 2.0 server, a public versioned API with
one error shape and cursor pagination, HMAC-signed webhooks with retries, a
dead-letter queue and replay, a typed zero-dependency SDK, a CLI, a developer
portal, and five working integrations. And it's the final quality bar too —
every claim you just saw is verified end-to-end, tested, and gated in CI against
the *deployed* system. Not 'works on my machine' — it works in production, on
every push. That's the platform."

*(Stop recording.)*

---

### If a beat fails on camera
- **Drill errors:** re-run it — it's deterministic (bounded polls, no sleeps). If
  login fails, re-check the two exported env vars in the setup step.
- **Want more visual?** Optionally run the dev portal locally
  (`pnpm --filter @ship/web dev` → `http://localhost:5173/devportal`) to show the
  app list, the delivery log, and the **Replay** button — but the three beats
  above are the submission; the portal is a bonus, not required.
