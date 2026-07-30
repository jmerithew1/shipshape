# terraform/render — Ship on Render

Declares the Ship API tier on Render as code: a project, a managed Postgres
instance, and a web service that builds this repo from git.

Full write-up — design decisions, the build/start commands, the app defects it
works around, and the blocker below — is in
[`docs/deployment-render.md`](../../docs/deployment-render.md).

## Pinned provider

```hcl
render = {
  source  = "render-oss/render"
  version = "1.9.1"   # exact, not ~>
}
```

`.terraform.lock.hcl` is committed (this directory's `.gitignore` negates the
parent `terraform/.gitignore` rule). `required_version = ">= 1.6.0"`; verified
with Terraform **v1.15.8**.

## Usage

```bash
export RENDER_API_KEY=...          # never goes in a file
export RENDER_OWNER_ID=tea-...
terraform init
terraform apply -var repo_url=https://github.com/<namespace>/shipshape
```

## Blocker — RESOLVED 2026-07-30

Render only builds from `github.com` or `gitlab.com`; this fork's origin is a
self-hosted GitLab, so the initial web-service create was rejected (evidence:
`out/02-apply.txt`). Resolved by mirroring to
`https://github.com/jmerithew1/shipshape` and applying with `-var repo_url=…`.
The full app (API + SPA via `SERVE_WEB`) is live at
**https://ship-api-llja.onrender.com** — deployed exclusively by
`terraform apply`; post-apply plan reports no drift (`out/06`, `out/09-10`).

One provider quirk worth knowing (evidence `out/08`): in-place updates of
**free-tier** services fail with "maintenance mode can only be configured for
non-free tier services". Workaround: `terraform apply -replace=render_web_service.api`
— recreation succeeds but mints a new `onrender.com` slug.

## Evidence (`out/`)

| File | What it is |
|---|---|
| `01-plan-initial.txt` | `terraform plan` before apply — `Plan: 3 to add` |
| `02-apply.txt` | `terraform apply` — project + Postgres created, web service rejected |
| `03-plan-after-apply.txt` | `terraform plan` after — `Plan: 1 to add, 0 to change, 0 to destroy` (the two created resources are converged) |

`fmt -check` exits 0 and `validate` reports
`Success! The configuration is valid.`
