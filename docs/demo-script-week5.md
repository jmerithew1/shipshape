# Week 5 Demo — FINAL cut: complete walkthrough & script

Single take, one browser window, 5 tabs, ~5 minutes. Stage every tab BEFORE
recording so each switch lands on a pre-loaded money shot.

## Part 1 — Stage the tabs

### Tab 1 — Ship (live app)
- URL: https://ship-api-r1om.onrender.com — logged in.
- Stage: project → Issues tab, "New issue" one click away.
- Shows: creating the orphan (trigger); later the chat panel; finally the
  toast + pulsing button + approval card (the live proof).

### Tab 2 — /ready
- URL: https://ship-api-r1om.onrender.com/ready
- Stage: loaded. One JSON line.
- Point at: `agent_tables: true` — refuses "ready" unless the agent's tables
  exist; came up green on a brand-new DB after the destroy-and-rebuild.

### Tab 3 — quiet-path trace
- URL: https://smith.langchain.com/public/08dd7d9f-dcd6-486a-9c43-d0ec8fc17639/r
- Stage: root run selected; duration (0.03 s) + 0 tokens visible.
- Point at: span list (ingestTrigger → three parallel fetches →
  runDetectors → recordQuiet) and what's NOT there — no model call; the
  0 tokens / 0.03 s figures; Input shows `"kind":"sweep"` (clock, not user).

### Tab 4 — multi-detector sweep trace
- URL: https://smith.langchain.com/public/f2d6e21e-14f4-4e96-84e5-1a23f5267842/r
- Stage: click the `triage` span → Input panel. Four candidates visible:
  orphan ("Fix login flow timeout"), stale ("Refactor auth session cache"),
  stuck review ("Add rate limiting to webhook endpoint"), week-slip
  ("Demo Week") with its `proposedAction.items` list (three issue titles).
- Point at: span tree (ONE run); the four stacked candidates (three detector
  types at once); the items array — literally the checkbox card's contents;
  then flip to Output — loss-framed slip title ("all 3 issues not started
  with 64% of week elapsed").

### Tab 5 — production timed-run trace
- URL: https://smith.langchain.com/public/06df5809-5e0a-431c-a00b-a6c2a2d26de6/r
- Stage: root run selected; the 19:20 UTC start timestamp near the top.
- Use: a TWO-SECOND receipt at the payoff beat — issue created 19:15:07,
  this run 19:20:02 = the measured 4m55s. Flick, show, flick back.

Recorder: Win + Alt + R, full-screen browser, mic on. Dry-run minute one
once for toast timing.

## Part 2 — Script

**0:00 — Tab 1** (setup + trigger)
> "This is Ship, live on Render, deployed entirely through Terraform. Inside
> it lives FleetGraph, the project-intelligence agent I built this week.
> Watch — I'll create a problem and the agent will find it on its own while
> I show you around."

Create the issue: title, no assignee, no week, click out.
> "New issue, nobody owns it, no week planned. Nobody's going to tell the
> agent. The clock starts now."

**0:40 — Tab 2** (point at agent_tables: true)
> "Everything — service, database, config — is Terraform. This readiness
> endpoint refuses to report ready unless the agent's tables actually exist
> in the database. We proved it the hard way: destroyed the entire
> environment, rebuilt it from the config alone, and this endpoint came up
> green on a brand-new database."

**1:10 — Tab 3** (span list, then 0 tokens / 0.03 s)
> "Traces are LangSmith, on from day one. My favorite trace: the agent swept
> a healthy project, found nothing, and stopped — thirty-three milliseconds,
> zero AI tokens, and look — no model call anywhere in this run. Staying
> quiet is a designed outcome. Measured across development: ninety-four
> percent of all graph runs never touched a model. Total AI spend to build
> this: about four cents."

**1:50 — Tab 4** (Input panel pre-loaded)
> "Same graph, different day: one sweep caught everything wrong at once — a
> stale issue, a stuck review, a slipping week, even an unassigned orphan.
> Four problems, one run." (point at items array) "The slipping week comes
> with a proposal — these three not-started issues — and in the UI that's a
> card with per-item checkboxes: I move only the ones I check, and the
> server refuses to touch anything that wasn't in the agent's own proposal."
> (flip to Output) "And look how it phrases it: 'all 3 issues not started
> with 64% of the week elapsed' — it leads with what's about to be lost,
> never a percentage dashboard. One more thing you can't see in a
> screenshot: the agent keeps a credibility score on itself, per person. If
> it's been wasting your attention, it raises its own bar before
> interrupting you again — critical always gets through, and it checks back
> in after five quiet days."

**2:50 — Tab 1, open any issue → Ask FleetGraph → click a suggested question**
> "Chat lives where you are — it says what it's scoped to, and the answer
> cites this issue's real state and timestamps. No standalone chatbot page."

**3:30 — wait beat (anywhere on Tab 1)**
> "Meanwhile the agent's on the clock — it deliberately waits ninety seconds
> after your last edit so it never nags you mid-thought. And everything
> you're watching is locked in CI: both agent modes run end-to-end on every
> push with fake models — zero live tokens — including a test that opens the
> circuit breaker and proves the agent degrades gracefully instead of
> crashing."

**~4:00 — payoff: toast slides in, button pulses**
> "There it is — found on its own, well inside five minutes. On the timed
> production test: four minutes fifty-five —" (flick to Tab 5, two seconds)
> "— timeline and trace are public."

**4:15 — open the card, Approve**
> "It proposes the fix — assign to the least-loaded teammate — but it never
> touches anyone's plan without a human. I approve, the agent executes, and
> the audit trail records both: human decided, agent acted."

**4:35 — close**
> "One graph, two doors. Deterministic checks in front of the model, a human
> on every gate, Terraform under all of it, and an agent that earns the
> right to interrupt. That's FleetGraph."

Stop recording.

## Coverage

| Graded item | Where |
| --- | --- |
| Proactive detection e2e, real data, timed | 0:00 create → 4:00 toast, live |
| Traces, different execution paths | Tabs 3 / 4 / 5 |
| All 5 use cases | orphan live · stale/stuck/slip on Tab 4 · chat 2:50 |
| HITL + allowlist | 4:15 approve + server-refusal line at 1:50 |
| Chat + notifications, embedded | 2:50 + 4:00 |
| Terraform, /ready, destroy-redeploy | 0:40 |
| Trigger model + grace window | 0:00 / 3:30 |
| Measured cost story | 1:10 (94%, four cents) |
| Engineering reqs (E2E in CI, degradation) | 3:30 |
| E1 credibility + checkbox + loss framing | 1:50 |

## Practical notes
- If the toast lands early, react early — either order covers everything.
- Keep rolling through hiccups; "while we wait…" reads as real.

---

# Week 5 MVP Demo Recording — single-take, one-window script (MVP cut, recorded)

Design constraints: simple, one browser window, every MVP requirement on
camera, ~4–5 minutes. The trick: create the issue FIRST — the detection wait
becomes the tour, so there is no dead air.

## Setup (before recording)

One browser window, 4 tabs in order:

1. Ship, logged in — https://ship-api-r1om.onrender.com — on the project's Issues view
2. https://ship-api-r1om.onrender.com/ready (loaded, JSON visible)
3. Quiet-path trace — https://smith.langchain.com/public/08dd7d9f-dcd6-486a-9c43-d0ec8fc17639/r
4. Finding-path trace (production) — https://smith.langchain.com/public/06df5809-5e0a-431c-a00b-a6c2a2d26de6/r

Recorder: Win + G (Game Bar) → Record (or Win + Alt + R), browser full-screen, mic on.

## Script

**0:00 — Tab 1, Issues view.**
> "This is Ship — our project management tool, live on Render, deployed
> entirely through Terraform. What I built this week is FleetGraph — the
> intelligence agent living inside it. I'm going to create a problem in
> Ship, and FleetGraph will find it on its own while I show you around."

**0:15 — Create the trigger** *(proactive detection, real data)*: New issue →
title ("Demo: payment retries failing") → **no assignee, no week** → click out.
> "A new issue, nobody assigned, no week planned — the kind of thing that
> silently dies in a backlog. No one is going to tell the agent about it.
> The clock starts now."

**0:40 — Tab 2** *(Terraform deploy, /health + /ready)*:
> "The whole environment — service, database, config — is Terraform. This is
> the readiness endpoint: it won't report ready unless the agent's tables
> actually exist in the database. Earlier today we tore the entire
> environment down and rebuilt it from the config alone — this same endpoint
> came up green on a brand-new database."

**1:10 — Tab 3, quiet trace** *(traces, different paths)*:
> "Observability is LangSmith, on from day one. This is my favorite trace:
> the agent swept a healthy project, found nothing, and stopped —
> thirty-three milliseconds, zero AI tokens, and you can see there's no
> model call anywhere in this run. Knowing when to stay quiet is a designed
> outcome, and it's what makes this a graph and not a pipeline."

*(The 0.03 s duration and 0 tokens are visible on the trace page itself; the
input panel shows the sweep trigger — started by the clock, not a user.)*

**1:40 — Tab 4, finding trace**:
> "Same graph, different conditions, different path: here it detects a
> problem, and only then does the AI wake up to phrase the card and rank it.
> Cheap deterministic checks gate the expensive model — a healthy project
> costs zero dollars."

(Point at the nodes: parallel fetches → runDetectors → triage → notify.)

**2:20 — Tab 1, open any existing issue** *(context-embedded chat)*: click
**Ask FleetGraph** (bottom-right) → click a suggested question.
> "Chat is embedded where you are — it says exactly what it's scoped to, and
> the answer cites this issue's real state and timestamps, not vibes. There
> is no standalone chatbot page."

**3:00 — Dashboard (or anywhere), waiting line:**
> "Meanwhile the agent's been on the clock — it waits 90 seconds after your
> last edit on purpose, so it never nags you mid-thought."

**~3:30 — The payoff** *(notifications in UI, detection < 5 min)*: toast
slides in, button pulses.
> "There it is — under five minutes from creation, no one asked. It announces
> once, and if I ignore it, it re-pulses on a schedule scaled to severity."

**3:45 — Open the card, Approve** *(human-in-the-loop)*:
> "It's not just detection — it proposes the fix: assign to the least-loaded
> teammate. But it never touches anyone's plan without a human. I approve —
> and the agent executes it, with the audit trail recording that a human
> decided and the agent acted."

Click through to the issue — assignee is now set.

**4:15 — Close:**
> "One graph, two doors, deployed by Terraform, traced end to end, and a
> human on every gate. That's FleetGraph."

Stop recording (Win + Alt + R).

## Requirement coverage

| MVP requirement | Covered at |
| --- | --- |
| Proactive detection e2e, real data, no mocks | 0:15 create → ~3:30 card, live and timed |
| Traces, ≥2 different execution paths | 1:10 quiet · 1:40 finding |
| Human-in-the-loop gate | 3:45 approve → assignment + audit |
| Chat + notifications in UI, context-embedded | 2:20 chat · 3:30 toast/pulse |
| Terraform deploy, /health + /ready, destroy-and-redeploy | 0:40 (spoken + on screen) |
| Trigger model (events + sweep + grace) | spoken at 0:15 / 3:00 / 3:30 |
| FLEETGRAPH.md sections | repo artifacts — no camera time needed |

## Final-scope addendum (optional 30 seconds, after the Approve beat)

If re-recording for Final, add one beat while on the findings panel:

> "Two more things shipped since the MVP. When a whole week is slipping,
> the card lists the not-started issues with checkboxes — I approve moving
> only the ones I check; the server refuses anything not in the agent's own
> proposal. And the agent now keeps a credibility score on itself, per
> person: if it's been wasting your attention, it raises its own bar before
> interrupting you again — critical findings always get through, and it
> re-checks in with you after five quiet days. Notifications as mechanism
> design, not settings."

## Practical notes

- Dry-run the first minute once: toast timing depends on the sweep. If the
  card lands early, react to it early and do the chat demo after — either
  order covers everything.
- If anything misfires, keep rolling — "and while we wait…" reads as real;
  a suspiciously perfect take doesn't.
