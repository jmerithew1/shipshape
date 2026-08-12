# Terraform Defense Map — one page, cold-recall

The live stack: `terraform/render/` — **3 resources, one dependency spine.** Provider
`render-oss/render` pinned **1.9.1** (`versions.tf`). State: local, gitignored (secrets land in
state — the reason it never leaves the laptop). The inherited AWS stack (`terraform/*.tf`, EB +
CloudFront + WAF) is independent and NOT the deployment; say so if shown a plan from it.

## The spine (memorize this line)

```
render_project.ship ──┬─▶ render_postgres.ship ──▶ (connection_info) ──▶ render_web_service.api
   (staging env id)   └───────────────────────────────────────────────▶ render_web_service.api
```

- **`render_project.ship`** — grouping + the `staging` environment. Both other resources reference
  `environments["staging"].id`.
- **`render_postgres.ship`** — Postgres 16, plan `free`, region `oregon`, db `ship_dev`, user
  `ship`, **no ip_allow_list = no public ingress** (private network only).
- **`render_web_service.api`** — plan `starter` (LOAD-BEARING: free tier idles → node-cron dies →
  FleetGraph detection guarantee dies), native Node runtime (NOT Docker — repo Dockerfile COPYs
  gitignored dist/), builds from the GitHub mirror (Render only fetches github.com/gitlab.com),
  `auto_deploy=false` (deploys: `terraform apply` or the CI deploy job, nothing else),
  health check `/health`, start = migrate-then-serve.

## Blast radius by resource (the answers, pre-derived)

| If the plan touches… | Symbol to expect | Blast radius |
|---|---|---|
| `render_project.ship` environments map | `-/+` (replacement) | **Maximum.** Both children reference the environment id → postgres AND web service replaced → **database destroyed** (free plan, no PITR) → all workspaces/apps/tokens/delivery logs gone → needs scripted repopulation (Week-5 destroy-redeploy runbook) |
| `render_postgres.ship` region/version | `-/+` | **Data loss.** Region must equal the service's (private-network DSN only resolves in-region) — a region change on ONE of the pair breaks the other even though the plan shows only one resource changing. DSN rotates → web service env updated → redeploy |
| `render_postgres.ship` plan free→basic | `~` or `-/+` (check the plan!) | If replacement: data loss as above. Provider quirk (Week 5): free→paid transitions can wedge in maintenance mode — use `-replace`, schedule around demos |
| `render_web_service.api` env_vars | `~` in-place | Triggers a deploy (provider waits on health check). `DATABASE_URL` is **derived** — it changes because postgres changed, not because someone edited it. `SESSION_SECRET` is `generate_value` — a service **replacement** regenerates it → **every session invalidated** (all users logged out) |
| `render_web_service.api` build/start command | `~` in-place + deploy | Bad build command = failed deploy; health check gate stops traffic cutover; rollback = revert + re-apply |
| `render_web_service.api` plan starter→free | `~`/quirk | Silent kill of FleetGraph cron + Week-6 webhook outbox poller (idle spin-down). Looks harmless in the plan; isn't |
| Provider version unpin / bump | plan-wide noise | Refuse casually: pinned 1.9.1 is a stated requirement; a bump can re-shape diffs for every resource |

## Plan-reading vocabulary (say these words)

`~` update in-place · `-/+` destroy-then-create (**replacement** — the dangerous one; find WHICH
attribute "forces replacement") · `+`/`-` create/destroy · `(known after apply)` computed —
downstream references go unknown and can cascade · `(sensitive value)` = secrets (DATABASE_URL,
API keys) — in state, never in output.

**Reading drill order:** 1) Plan summary line (x add, y change, z destroy). 2) Any `-/+`? Name the
attribute that forces it. 3) Walk the spine downstream of every change (project → postgres → DSN →
service env → deploy → sessions/cron). 4) Name the risky ops out loud: data loss, secret rotation,
session invalidation, cron/poller death, region pair-breaking. 5) State the rollback (revert config,
re-apply; DB loss = repopulation runbook).

## Week-6 planned additions (keep this map current as they land)

New `env_vars` on the web service only (`~` in-place + deploy each): `WEBHOOKS_ENABLED`,
`SHIP_AGENT_CLIENT_SECRET` (agent OAuth app, TF_VAR posture like the API keys), possibly
`APP_BASE_URL` (OAuth redirect validation). **No new resources planned on the live stack.** The
IAM least-privilege exercise is a separate scratch config (SSM params + IAM user) — see
DECISIONS 2026-08-10; it shares no state with this stack, blast radius zero.
