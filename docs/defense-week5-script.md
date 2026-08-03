# Week 5 Defense — light script

One big idea per beat. Say it in your own words — the "say something like"
lines are a starting point, not a script to memorize. Deep answers live in
the [Q&A brief](defense-week5-fleetgraph.md); don't front-load them.

## Prep (10 min before)

1. Open VS Code in `shipshape`. Open two tabs: `FLEETGRAPH.md`, `DECISIONS.md`.
2. With FLEETGRAPH.md focused, press **Ctrl+Shift+V** to preview. If the
   diagram is a code block instead of boxes: Extensions icon → search
   `Markdown Preview Mermaid Support` → Install → reopen preview.
3. Keep the Q&A brief on your phone or printed. That's your answer sheet.

---

## Beat 1 — What it is (about 1 min)
`[SCREEN]` FLEETGRAPH.md top, then scroll to the Autonomy boundary table.

**The idea: Ship shows you what's happening. FleetGraph tells you what's
wrong — especially when the signal is silence.**

Say something like:
- "Dashboards only show activity. The worst problems are *no* activity — an
  issue nobody's touched in four days doesn't ping anyone. FleetGraph watches
  for that."
- "It works like a good project coordinator: it notices, it drafts the fix,
  but it never rewrites your plan without asking."
- "And the safety isn't a prompt saying 'please be careful' — the code that
  executes actions literally has no delete button. The AI suggests;
  plain TypeScript decides."

## Beat 2 — One brain, two doors (about 1 min)
`[SCREEN]` the graph diagram in preview.

**The idea: the same graph runs whether the agent wakes itself up or a user
opens chat. The only difference is which door it came in through.**

Say something like:
- "Proactive mode and chat mode are the same graph — same reasoning, same
  safety gates. Just different triggers."
- "Cheap checks run first: plain SQL rules decide if anything even looks
  wrong. The expensive AI brain only wakes up when they fire. A healthy
  project costs zero tokens." *(point at the quiet path)* "This branch —
  where it finds nothing and says nothing — is a real outcome we trace.
  Knowing when to shut up is a feature."

## Beat 3 — How it knows, and how fast (about 1 min)
`[SCREEN]` Trigger Model section.

**The idea: events for things that happen, a clock for things that don't.**

Say something like:
- "When someone creates or changes an issue, the agent hears it instantly —
  it lives inside the app, so there's no webhook plumbing."
- "But staleness is the *absence* of events, so a lightweight sweep runs
  every two minutes. It's just SQL — basically free."
- "For the graded stopwatch test: create an unassigned issue, and the card
  shows up in about two to three minutes. We wait 90 seconds on purpose —
  every new issue is born empty for a few seconds while you type, and we
  don't want to nag people mid-keystroke."

## Beat 4 — Built so people don't hate it (about 45s)
`[SCREEN]` Use Cases table.

**The idea: the hard part of a nagging agent isn't detection — it's not
becoming noise.**

Say something like:
- "Every finding talks about the work, never the person. 'This issue has been
  quiet for four days,' not 'you haven't done your job.'"
- "One tap says 'still on it' and the agent goes away — nobody gets told.
  If it ever escalates, the card warned you first."
- "Each problem notifies once, and the card disappears on its own when the
  problem gets fixed. The surface only ever shows live issues."

## Beat 5 — Why you can trust the plan (about 45s)
`[SCREEN]` switch to DECISIONS.md, top entries.

**The idea: we attacked our own design before writing any code.**

Say something like:
- "Honest status: zero FleetGraph code exists yet, and the doc says so in
  writing. What we do have is a design that's already been beaten up twice."
- "We ran three scoping reviews, then handed the spec to a fresh 'red team'
  pass with no context. It found three real problems in our own
  infrastructure — including a deploy defect from last week that would have
  silently broken the agent's database tables. All fixed in the plan before
  they could bite."
- "Every decision in this log has the alternative we rejected written next
  to it. Happy to take questions."

---

## If you only get 3 minutes
Beats 1, 2, 3 — then jump to Beat 5's last line. Beats 4's material makes a
great *answer* when someone asks about notification spam.

## Fallbacks
- **Diagram won't render:** skip it — Beat 2's words carry the idea without
  the picture.
- **Question you don't know:** "That part is designed but not built yet — the
  doc is explicit about which is which. The design intent is…" (then it's
  fine to reason out loud).
- **"Show me code":** "There isn't any yet, on purpose — this checkpoint is
  four hours in. What I can show you is the decision log." *(DECISIONS.md)*
- **Numbers:** never claim a measurement. Everything today is a budget or an
  estimate, and say so — the plan includes an accounting table that turns
  them into measurements.
