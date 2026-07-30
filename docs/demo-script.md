# Demo Video Script — Week 4 (target 3:30–4:30)

## Pre-flight (do ALL of this before hitting record — ~10 min)

**Wake the server first** (free tier sleeps; first hit takes ~50 s):
1. Visit https://ship-api-llja.onrender.com/health — wait for `{"status":"ok"}`.

**Window 1 — Browser, three tabs (your main recording surface):**
- Tab 1: https://ship-api-llja.onrender.com — log in `dev@ship.local` / `admin123`. Create a fresh
  document, title it `Demo`, leave it open. **Copy its URL.**
- Tab 2: your GitHub Actions page → the latest green run (open the run so the green checkmarks
  are visible): https://github.com/jmerithew1/shipshape/actions
- Tab 3: https://ship-api-llja.onrender.com/api/docs/ (Swagger, loaded).

**Window 2 — a separate browser window in InPrivate/Incognito:**
- Log in as `bob.martinez@ship.local` / `admin123`, paste the Demo doc URL, leave it open
  **side-by-side with Window 1** (snap each to half the screen with `Win+←` / `Win+→`).

**Window 3 — VS Code with four files open as tabs (in this order):**
- `AUDIT_REPORT.md` — scrolled to **"Post-draft change log (added 2026-07-29)"**
- `AUDIT_REPORT.md` will also be used at **"Phase-2 results summary"** — know where it is (Ctrl+F "Phase-2 results")
- `bench/cat3-latency/out/NOTES-2026-07-29.md` — scrolled to the variance table
- `bench/cat7-a11y/out/nvda-session-2026-07-29.md` — scrolled to the Summary section

**Window 4 — Git Bash terminal**, `cd` into the repo, and pre-type (don't run) this in the prompt:
```bash
node bench/cat1-types/count-types.mjs "$(pwd -W)" 2>/dev/null | head -2
```

Mic check, close Slack/notifications, screen record at full screen. Switch windows with `Alt+Tab`.

---

## The script — beat by beat

### Beat 1 — The hook (0:00–0:35) · Window 3, change-log section on screen

**Say:** "This week I inherited a real U.S. Treasury project-management monorepo — React, Express,
Postgres, live collaboration over Yjs. I audited it in 36 hours, then had to improve all eight
categories I'd measured. But the most important part of this report is this table — my reviewers
caught my audit claiming *nothing was fixed* while my commit history said otherwise. So the first
thing I shipped was this: a change log reconciling every post-draft commit against every claim it
affected, with dated corrections in place. Everything else this week is built on that standard:
no claim outlives its evidence."

**Do:** slowly scroll the change-log table while talking.

### Beat 2 — Measurement culture (0:35–1:25) · Window 4, then Window 3

**Say:** "Every number in this project comes from a committed instrument, not a vibe. Here's the
type-safety counter running live —" **Do:** press Enter on the pre-typed command; the GRAND TOTAL
line prints. "— 882 violations, down from twelve-hundred-and-eight at the re-baseline: minus
twenty-seven percent, and both the before and after files are committed, so anyone can re-run this."

**Do:** Alt+Tab to VS Code, click the results-summary section (Ctrl+F "Phase-2 results").
**Say:** "Same story in every category — each row of this table is a re-baseline artifact and an
after artifact at named commits: bundle minus fifty-eight, queries minus twenty-two, P95 down
twenty-four to sixty-three percent on two endpoints."

### Beat 3 — Show it working (1:25–2:30) · Windows 1+2 side by side

**Do:** arrange the two browser windows side-by-side, both showing the `Demo` document. Click into
Window 1's editor and type a sentence; watch it appear in Window 2. Then click **both cursors into
the same paragraph** and type simultaneously for two seconds.

**Say (while typing):** "This is the live deployment — two different users in the same document.
Real-time sync had zero test coverage when I arrived; now there's a spec asserting CRDT convergence
and zero character loss, and running it taught me something code-reading never could — two people
typing at the same position get interleaved character-by-character. Converges perfectly, loses
nothing, looks wild. That's now documented behavior with a committed measurement."

**Do:** press F12 in Window 1 → Network tab → Ctrl+Shift+R (hard reload).
**Say:** "And this first load is 58 percent smaller than the audit baseline — the editor stack and
the emoji picker only load when routes actually need them. Verified at the network level under a
throttled 3G profile: cold login went from 605 to 243 kilobytes."

### Beat 4 — The honest parts (2:30–3:15) · Window 3

**Do:** switch to `NOTES-2026-07-29.md`, show the variance table, scroll to the final section.
**Say:** "Where I'm proudest is what happened when measurements disagreed. Two benchmark runs of the
same code differed by twenty percent — so I committed *both* runs and wrote down why, instead of
re-rolling until a number looked good. Three latency attempts produced nothing provable; the
committed diagnosis from those failures pointed at the one endpoint that was actually
database-bound, and fixing *that* delivered thirty-plus percent, twice, at both concurrency levels."

**Do:** flip to the NVDA results tab, show the Summary.
**Say:** "I also ran a real NVDA screen-reader session myself — and it *overturned* one of my own
audit findings: the dialog focus-trap I'd statically flagged as broken works fine under real
assistive technology. Thirteen passes, zero fails, and two new findings only a screen reader could
catch."

### Beat 5 — Close (3:15–3:45) · Window 1 tabs

**Do:** switch to Tab 3 (Swagger), then Tab 2 (green Actions run), linger 2 seconds on each.
**Say:** "The whole thing deploys with one terraform apply — the post-apply plan says 'no changes',
CI is green on every push — build, lint, strict types, tests against a real Postgres, coverage,
dependency audit, secret scan — and the tag `week4-implementation` marks the exact commit you're
looking at. Everything I claimed this week, you can re-run. Thanks."

---

## If something goes wrong mid-take

- **Render is asleep** (page hangs): you skipped pre-flight — hit /health, wait for `ok`, restart the take.
- **Collab looks laggy:** free-tier cold WebSocket; type a few characters, give it 2 s, it catches up — narrate it honestly ("free tier waking up") or re-take.
- **Counter command errors:** you're not in the repo root — `cd "C:/Users/merit/OneDrive/Desktop/shipshape"` and re-run.
- Total over 5 min? Cut Beat 3's DevTools portion first, then shorten Beat 1's scroll.
