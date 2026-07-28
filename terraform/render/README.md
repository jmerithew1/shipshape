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

## ⚠️ Blocker

Render only builds from `github.com` or `gitlab.com`. This fork's origin is a
self-hosted GitLab, so the web service cannot be created from it. The project
and the database applied cleanly; the web service was rejected by the API.
Mirror the fork to one of the two supported hosts and pass `-var repo_url=...`
— that is the only change needed.

## Evidence (`out/`)

| File | What it is |
|---|---|
| `01-plan-initial.txt` | `terraform plan` before apply — `Plan: 3 to add` |
| `02-apply.txt` | `terraform apply` — project + Postgres created, web service rejected |
| `03-plan-after-apply.txt` | `terraform plan` after — `Plan: 1 to add, 0 to change, 0 to destroy` (the two created resources are converged) |

`fmt -check` exits 0 and `validate` reports
`Success! The configuration is valid.`
