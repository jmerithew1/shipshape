# Week 5 Defense — speakable script + screen walkthrough

Read the **bold lines aloud** (or your own words — they're written to be
spoken). `[SCREEN]` lines say exactly what to have visible. Timestamps assume
a 5-minute slot; the 3-minute cut is at the bottom.

## Prep — do this 10 minutes before (one-time, ~3 min)

1. Open VS Code in the `shipshape` folder.
2. Open these four files as tabs, in this order (Ctrl+P, type the name,
   Enter): `FLEETGRAPH.md`, `DECISIONS.md`, `PRESEARCH.md`,
   `docs/defense-week5-fleetgraph.md` (the Q&A brief — keep it on a second
   monitor or printed if you can; it's your answer sheet).
3. For the diagram: with `FLEETGRAPH.md` focused, press **Ctrl+Shift+V**
   (markdown preview). Scroll to the flowchart under "Graph Diagram."
   - If the diagram shows as a code block instead of boxes-and-arrows: click
     the Extensions icon (left rail, 4 squares) → search
     `Markdown Preview Mermaid Support` (publisher: Matt Bierner) → Install →
     close and reopen the preview. Takes ~30 seconds.
4. In the preview, scroll back to the top of FLEETGRAPH.md. That's your
   opening screen.

## The script

### 0:00 – 0:20 — Open with the honesty frame
`[SCREEN]` FLEETGRAPH.md preview, top — the status banner table is visible.

**"This is an architecture defense, so I'll be precise about status: no
FleetGraph code exists yet — the status banner says exactly that in writing.
Everything I cite about Ship itself is shipped code with file-and-line
references. And this design has already survived two adversarial passes
before a single line gets written — I'll come back to that at the end."**

### 0:20 – 1:15 — Beat 1: jurisdiction and the autonomy boundary
`[SCREEN]` scroll to **Agent Responsibility** → stop at the **Autonomy
boundary** table (three tiers).

**"FleetGraph's jurisdiction is project-execution health. The key design
insight: the most important signals are silence, not events — a stale issue
emits nothing. It watches for stale work, stuck reviews, week slip, and
orphaned intake."**

**"The autonomy boundary is three hard tiers. Autonomous: anything additive
and attributed — findings, cards, agent comments. Human approval: any
mutation of a person's plan. And a 'never' tier — delete, auth, external
comms — enforced by a deterministic TypeScript allowlist, not by prompt
instructions. The model proposes; deterministic code disposes. A prompt
injection lands on an executor that has no delete verb."**

**"Five use cases, all built and traced by final. Two more we discovered and
deliberately deferred, with written rationale — because the rubric requires a
trace and regression tests per defined use case, the defined set equals the
built set. No empty cells in a graded table."**

### 1:15 – 2:15 — Beat 2: one graph, two triggers
`[SCREEN]` scroll to the **Graph Diagram** flowchart.

**"One LangGraph StateGraph. Proactive and on-demand are the same graph —
the difference is the trigger payload, top-left. Parallel fetch, then a
deterministic detector stage — no LLM — then conditional edges."**

*(point at the quiet path)* **"This branch matters most: a healthy project's
sweep ends at recordQuiet with zero LLM calls. That's what makes this a graph
and not a pipeline — different Ship states drive visibly different execution
paths, and our two MVP trace links are exactly this quiet path next to a
finding path."**

### 2:15 – 3:15 — Beat 3: trigger model and the graded clock
`[SCREEN]` scroll to **Trigger Model** — the poll/event/hybrid comparison
table.

**"Hybrid trigger, and here's the defense: events alone are structurally
blind to inactivity — no webhook fires when an issue sits untouched four
days. A clock for silence, events for mutations. And because the agent lives
inside the Ship API process, webhooks collapse into in-process event
emission — we verified the change logger never fires on document creation,
so we hook the create routes explicitly. The sweep is SQL-only every two
minutes, which is effectively free."**

**"For the graded timed test: create event, a 90-second grace window — Ship
births every issue as 'Untitled' and momentarily unassigned, so firing
instantly would be a noise firehose — then debounce, two seconds of SQL,
about ten seconds of LLM. Two to three minutes against a five-minute goal,
and the card prints its own grace window so the demo explains itself."**

### 3:15 – 3:55 — Beat 4: cost is structural
`[SCREEN]` stay on the Trigger Model table — point at the cost column.

**"Cost control is structural, not aspirational. The LLM sits behind the
deterministic detectors and behind dedup memory — a quiet project costs zero
tokens at any scale. Spend scales with findings and chat use, not with the
number of projects monitored. Haiku for triage because detectors
pre-structure the input; Sonnet for chat because that's the user-facing
surface. Every call goes through ChatAnthropic so every token lands in
LangSmith — the final cost analysis will be measured, not estimated."**

### 3:55 – 4:30 — Beat 5: trust surfaces
`[SCREEN]` scroll up to the **Use Cases** table.

**"Human-in-the-loop is a LangGraph interrupt — the gate is visible in the
trace itself. Approval cards render in Ship's existing ActionItems surface;
we deliberately did not invent a new inbox. The card anatomy is designed for
trust: evidence inline, escalation forewarned on the card — never silent —
per-item checkboxes on multi-issue proposals, and a one-tap 'Still on it'
that resets the clock and notifies nobody, so clearing a false alarm is
cheaper than ignoring the agent. Findings are phrased about the artifact,
never the person. And findings auto-resolve when the condition clears, so
the surface only ever shows live problems."**

### 4:30 – 5:00 — Beat 6: the de-risk story (close strong)
`[SCREEN]` switch to the `DECISIONS.md` tab — top two entries visible.

**"Last thing, and it's the reason to believe this plan: before writing any
code we ran a three-lens scoping pass and then a blind cold critic against
the spec. The critic found three silent failure modes — verified against our
own repo: a known migration-runner defect that would have silently eaten the
agent's tables on Render, deploy-on-push contradicting our CI-gated-deploy
claim, and a destroy-and-redeploy test that takes the database with it. All
three are folded into the plan with fixes scheduled before they can bite.
Eleven decisions in this log, every one with an explicit rejected
alternative. Happy to take questions."**

---

## 3-minute cut (if time is short)

Keep Beats 1, 2, 3 (jurisdiction / graph / trigger) at ~50s each, then jump
straight to the Beat 6 close at ~30s. Drop Beats 4 and 5 — their content is
in the Q&A brief and both have strong prepared answers ("what does a run
cost?", "how do you avoid notification fatigue?").

## On-the-day fallbacks

- **Mermaid won't render:** narrate from the raw code block — the node names
  read cleanly top to bottom (ingestTrigger → loadContext → fetch × 3 →
  runDetectors → quiet OR triage → gate/notify/respond). The argument doesn't
  need the picture.
- **Asked something not in the Q&A brief:** the honest fallback that always
  works: *"That's designed but not yet wired — the status banner is explicit
  about that split. Here's the design intent…"* Never claim a measurement.
- **Asked to show code:** *"There isn't any yet, by design — this checkpoint
  is four hours in. What I can show is the decision log and the build order,
  which starts with fixing a real defect in our own Week-4 migration runner
  before it can eat the new tables."* (Then show DECISIONS.md.)
- **Asked about LangSmith setup:** keys are being provisioned today; tracing
  is wired from the first line of graph code, and the two MVP trace links are
  named in the Test Cases table (quiet path + finding path).
