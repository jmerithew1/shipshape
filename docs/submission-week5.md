# Week 5 MVP Submission — FleetGraph

## Links

| Artifact | Link |
| --- | --- |
| Deployed app (public, Starter tier) | https://ship-api-il12.onrender.com |
| Health / readiness | https://ship-api-il12.onrender.com/health · https://ship-api-il12.onrender.com/ready (asserts agent tables — returned `{"status":"ready","agent_tables":true}` on deploy day) |
| Repo (origin) | https://labs.gauntletai.com/jamesmerithew/shipshape |
| Repo (GitHub mirror, CI + deploys) | https://github.com/jmerithew1/shipshape |
| FLEETGRAPH.md (all MVP sections) | repo root — Agent Responsibility · Graph Diagram · 5 Use Cases · Trigger Model · Test Cases w/ trace links |
| PRESEARCH.md | repo root |
| Trace — finding path (orphan detected, Haiku triage, 2 055 ms) | https://smith.langchain.com/public/9e688edf-1545-4de8-8915-0b0d198e40e1/r |
| Trace — quiet path (dedup, zero LLM calls, 67 ms) | https://smith.langchain.com/public/08dd7d9f-dcd6-486a-9c43-d0ec8fc17639/r |
| Trace — chat path (grounded, claim-vs-state) | https://smith.langchain.com/public/810f4f6b-648b-4e47-9a77-8145a0b3ecc6/r |
| Terraform plan (annotated) | `terraform/render/out/10-plan-week5.txt` |
| Terraform apply | `terraform/render/out/11-apply-week5-replace.txt` |
| Dev docs | `CHANGES.md` (Week 5 section: run / test / deploy / rollback) |
| Decision log | `DECISIONS.md` (15 entries, each with a Rejected clause) |

## MVP checklist → evidence

| Requirement | Evidence |
| --- | --- |
| Graph + ≥1 proactive detection e2e, real data, no mocks | Orphan intake live: planted unassigned issue → sweep → Haiku-triaged card in `agent_findings` (`path=finding`, 2 055 ms). Trigger = in-process events (create route + `logDocumentChange` chokepoint) + 2-min SQL-only sweep. |
| LangSmith tracing, ≥2 links, different execution paths | Three public links above: finding vs quiet vs chat — same graph, visibly different paths (quiet ends at `recordQuiet`, zero tokens). |
| FLEETGRAPH.md: Responsibility, Diagram, ≥5 Use Cases, Trigger Model | All complete; status banner separates ✅ shipped (file-cited) from 🔜 scheduled. |
| ≥1 human-in-the-loop gate | Approval card → Approve executed live: issue assigned, `document_history.automated_by='fleetgraph'`. Executor is a deterministic allowlist (no delete/auth/external verbs). |
| Agent chat + notifications accessible in UI | Global bottom-right FleetGraph widget on every page (toast on new findings, severity-scaled re-pulse, nothing rendered when quiet); "Ask FleetGraph" panel on every document view — scoped ("Discussing: <title>"), grounded (cites real state/assignee/timestamps). No standalone chat page. |
| Deployed via Terraform: agent service, env config w/o secrets, /health + /ready, annotated plan, destroy-and-redeploy | `terraform/render/`: Starter tier (idling would kill the proactive guarantee), FleetGraph env via sensitive TF_VARs, `auto_deploy=false` + CI-gated deploy job. Plan/apply outputs committed. Destroy-and-redeploy proof scheduled Friday with scripted repopulation (documented in the plan). |
| Trigger model documented + defended | FLEETGRAPH.md §Trigger Model — hybrid, with the cost/latency table and the "silence needs a clock" argument. |
| Detection latency < 5 min | **Measured on production: 4 m 55 s** (issue 19:15:07 UTC → card 19:20:02 UTC, incl. the deliberate 90 s grace window; full timeline + trace below). Cost per run and runs/day documented and defended in FLEETGRAPH.md §Cost Analysis. |

## Timed rehearsal on production (2026-08-04, live Render instance)

- Issue "demo issue" created (no assignee, no week): **19:15:07 UTC**
- Detected + card written (`notify` node, Haiku triage 670 tokens): **19:20:02 UTC**
- **Measured detection latency: 4 m 55 s** against the 5:00 goal — includes
  the deliberate 90 s no-edit grace window, which reset while the reporter
  finished typing (by design; the window is printed on the card)
- Production trace (public): https://smith.langchain.com/public/06df5809-5e0a-431c-a00b-a6c2a2d26de6/r
- Notification surface (upgraded from field feedback during this rehearsal):
  global bottom-right widget on every page — new findings announce once via
  toast, the button pulses until the panel is opened, and the widget renders
  nothing when there are no findings. The full HITL loop (Approve →
  agent-attributed assignment) runs from the same widget.

## Notes for graders

- The quiet path is a first-class, traced outcome: a healthy project costs
  $0 in tokens at any scale, because deterministic SQL detectors gate the
  LLM (economics-lens decision, FLEETGRAPH.md §Trigger Model).
- Cards are built from behavioral-econ decisions (defaults, friction
  asymmetry, loss framing, incentive-compatible disclosure) — documented in
  FLEETGRAPH.md and DECISIONS.md; the credibility-weighted alerting
  mechanism (E1) is schema'd and accumulating evidence since MVP, with
  thresholding scheduled Thu–Fri.
- Deferred by design, with rationale: accountability-gap detection, daily
  digest (FLEETGRAPH.md §Discovered, deliberately deferred).
