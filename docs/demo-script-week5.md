# Week 5 MVP Demo Recording — single-take, one-window script

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
