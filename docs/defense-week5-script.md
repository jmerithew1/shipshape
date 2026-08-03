# Week 5 Defense — room script (persuasive cut)

One page on screen: `docs/defense-week5-onepager.html` — scroll top to bottom
as you talk. Each beat: **the idea**, a few lines to say your way, and the
**"how we decided"** thread that runs through the whole talk. Deep answers
live in the [Q&A brief](defense-week5-fleetgraph.md).

**The spine of the talk (say it if you say nothing else):** *we didn't just
design an agent — we ran a decision process: three lenses to scope it, game
theory to make it trustworthy, behavioral economics to make it humane, and a
blind red team to break it before it shipped.*

## Prep (5 min before)
1. Open `docs/defense-week5-onepager.html` in a browser (double-click it).
2. Q&A brief on your phone or printed.
3. That's it — the one page carries the whole talk.

---

## Open — the cost of silence (20s)
`[SCREEN]` top of the page — the dark hero panel. The Tuesday/Friday story is
printed right there; you can literally read it. The radar figure on the right
is your visual: four drift signals converging on one watching dot — gesture
at it on the second line.

- "Tuesday: an issue goes quiet. No event fires, nothing turns red. Friday:
  it's why the week slips — and everyone finds out at the retro."
- "Every tool in this market shows you activity. Nothing watches the
  silence. That's the gap FleetGraph fills."

*(Why this works on a room: loss framing — people move to prevent a loss
they can picture. One vivid story beats ten statistics.)*

## Beat 1 — A coordinator, not a dashboard (1 min)
`[SCREEN]` the cream panel — three tier cards: Acts alone / Asks first /
Never.

- "It notices, it drafts the fix, and it never rewrites your plan without
  asking. Three hard tiers — and the bottom one isn't a guideline, the
  executor literally has no delete verb in it."
- **Decision thread:** "Every scope choice went through three lenses — worth
  building? will a human want it? does the data exist? We found seven use
  cases and built five, because the graded table demands a real trace per
  row. We define exactly what we can prove."

## Beat 2 — One brain, two doors (1 min)
`[SCREEN]` the dark panel — the chip pipeline: two ghost door chips → sand
chips (detectors → AI triage → human gate); the quiet path is the hairline
aside underneath.

- "Proactive mode and chat are the same graph — same reasoning, same gates,
  different trigger."
- "Cheap SQL checks run first; the expensive model only wakes when they
  fire." *(point at the green box)* "A healthy project ends here — zero
  tokens. Knowing when to shut up is a feature, and it's traced."
- **Decision thread:** "That ordering is an economics-lens decision: our cost
  scales with problems found, not projects watched. Watching one more
  healthy project costs nothing."

## Beat 3 — Events and the clock (45s)
`[SCREEN]` the cream panel — the hairline timeline: 0:00 created → ≈2:30
card visible → 5:00 goal.

- "Things that happen, we hear instantly — we live in the app. Things that
  *don't* happen need a clock — a two-minute sweep."
- "Graded test: create an unassigned issue, card visible in two to three
  minutes against the five-minute goal."
- **Decision thread:** "The 90-second pause is the psychology lens colliding
  with a data-model fact: every issue is born empty while someone types.
  We spend 90 of our 300 seconds on manners — and the card prints its own
  grace window, so the demo explains itself."

## Beat 4 — It earns the right to interrupt (1.5 min — the centerpiece)
`[SCREEN]` the cream panel — approval card mockup on the left, credibility
score meters on the right; the four behavioral-econ labels sit below in the
hairline grid.

- "Here's the part nobody else ships. Alerting is a repeated game — every
  false alarm spends trust you don't get back. Every competitor handles this
  with static thresholds an admin sets once. FleetGraph keeps score of its
  own usefulness, per person, per finding type."
- *(point at the meters)* "Sam dismissed seven of the last nine stale-issue
  nudges — so for Sam, stale nudges now need to be big to interrupt. Dana
  acts on them — Dana keeps the normal threshold. It forgets old evidence on
  purpose, critical severity always gets through, and the math has guards so
  it can never talk itself into permanent silence."
- "And the card itself is applied behavioral economics:" *(walk the four
  labels)* "proposals arrive pre-checked so agreeing is one click; 'Still on
  it' is the cheapest button because clearing a false alarm must cost less
  than ignoring the agent; cards say '3 issues won't make Friday,' not
  'completion rate 20%'; and if you report a slip before the agent finds it,
  it's a recalibration, not a failure — hiding bad news stops paying."
- **Decision thread:** "We treated notifications as a mechanism-design
  problem, not a settings page."

## Beat 5 — We attacked it ourselves (45s — the close)
`[SCREEN]` the final dark panel — the small radar ("spec in / 3 defects
out") beside the three ✕ findings.

- "Before writing code, we gave the spec to a critic with zero context and
  orders to break it. It found three real problems in our own
  infrastructure — a deploy defect that would have silently eaten the
  agent's tables, a deploy-on-push contradiction, and a rebuild test that
  destroys its own demo data. All verified, all fixed in the plan."
- "Same discipline on ideas coming in: ten game-theory features were
  pitched at us; three survived the feasibility check against our own
  schema. Every yes and every no is logged with the alternative next to it."
- "That's the submission: not just an agent — a decision process you can
  audit. Questions?"

*(Why this closes: peak-end rule — the last thing they remember is you
red-teaming yourself. Nobody else in the room will have that.)*

---

## If you only get 3 minutes
Open + Beat 2 + Beat 4 + Beat 5's last two lines. Beat 4 is the
differentiator — never cut it.

## Fallbacks
- **Question you don't know:** "Designed but not built yet — the doc labels
  which is which. The design intent is…" (then reason out loud, it's fine).
- **"Show me code":** "None yet, on purpose — this checkpoint is hours in.
  What I can show is the decision log." *(open DECISIONS.md)*
- **"Is the credibility score built?"** "It's designed and scheduled for
  Thursday, after the compliant baseline deploys Tuesday — and it's schema'd
  from day one. The baseline always wins the clock; the doc says exactly
  that."
- **Numbers:** everything today is a budget or estimate — say so, every
  time. The plan includes the accounting table that turns them into
  measurements.
