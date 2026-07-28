# Deploying Ship to Render with Terraform

`terraform/render/` declares the whole API tier as code: a Render project, a
managed Postgres instance, and a web service that builds this repo from git.
It exists to replace the manual deploy steps — from a clean machine the entire
deployment is meant to be:

```bash
export RENDER_API_KEY=...          # dashboard.render.com/settings#api-keys
export RENDER_OWNER_ID=tea-...     # curl -H "Authorization: Bearer $RENDER_API_KEY" https://api.render.com/v1/owners
cd terraform/render
terraform init
terraform apply -var repo_url=https://github.com/<namespace>/shipshape
```

No `.tfvars` file, no secrets on disk: the provider reads `RENDER_API_KEY`
straight from the environment.

Read the blocker below before you run it.

---

## Status: 2 of 3 resources deployed

Applied against the live Render API on **2026-07-28** with **Terraform
v1.15.8** and **render-oss/render v1.9.1**:

| Resource | Result |
|---|---|
| `render_project.ship` | ✅ created — `prj-d9keaotg1s2s73futqeg` |
| `render_postgres.ship` | ✅ created — `dpg-d9keaortqb8s73bbtjag-a`, status `available`, Postgres 16, free plan, oregon |
| `render_web_service.api` | ❌ rejected by the Render API — see below |

Re-running `terraform plan` after the partial apply reports
`Plan: 1 to add, 0 to change, 0 to destroy.` — the two created resources are
stable and converged; only the web service is outstanding. Raw output is in
`terraform/render/out/`.

**There is no deployed URL and no `/health` response to report.** The service
was never created, so nothing was reachable to test.

---

## The blocker: Render only builds from github.com or gitlab.com

This fork's origin is a self-hosted GitLab:
`https://labs.gauntletai.com/jamesmerithew/shipshape`. Render refuses it.
Verbatim from the API during `terraform apply`:

```
Error: Error creating service

  with render_web_service.api,
  on main.tf line 111, in resource "render_web_service" "api":

Could not create service, unexpected error: could not create service: passed
in repository URL is invalid or unfetchable:
https://labs.gauntletai.com/jamesmerithew/shipshape. Accepted formats are:
https://github.com/{namespace}/{repository} or
https://gitlab.com/{namespace}/{repository}. You may pass in a branch in the
branch field.
```

Things that are *not* the cause, and were checked:

- **Not an auth problem.** `git ls-remote https://labs.gauntletai.com/jamesmerithew/shipshape.git`
  succeeds anonymously — the repo is publicly cloneable. Render allowlists the
  two hosts by name regardless of reachability.
- **Not a credentials problem.** The same API key created the project and the
  database in the same apply, seconds earlier.
- **Not a config problem.** `terraform validate` passes, `fmt -check` is
  clean, and the plan is exactly the three intended resources.
- **No public mirror exists.** `https://github.com/US-Department-of-the-Treasury/ship`
  (linked from the README) returns 404 unauthenticated.

### The fix

Mirror the fork to github.com or gitlab.com, then pass its URL:

```bash
terraform apply -var repo_url=https://github.com/<namespace>/shipshape
```

That is the only change required. Nothing else in the config depends on the
git host. **Pushing this repo to a public host is a decision for the repo
owner, not something automation should do** — it publishes the codebase.

### Rejected alternatives

| Option | Why not |
|---|---|
| `runtime_source.docker` pointed at the self-hosted GitLab | Same host allowlist. `docker.repo_url` is validated identically. |
| `runtime_source.image` from a registry | Needs a published image. The repo has no registry pipeline, and the `Dockerfile` cannot build one unattended (below). |
| Deploy the public upstream instead | It is 404, and it would not be this fork. A URL serving someone else's code is not evidence that this deploys. |

---

## Design decisions

### Native Node runtime, not Docker

`runtime_source.native_runtime`, deliberately. The repo's `Dockerfile` is not
self-contained:

```dockerfile
COPY shared/dist/ ./shared/dist/
COPY api/dist/ ./api/dist/
```

`dist` is in `.gitignore`. Those directories do not exist in a fresh clone —
the image only builds on a host that has already run the build locally. Render
builds from a clean checkout, so the `COPY` would fail. The native runtime
runs the real build on Render, which is what makes "deployable from a clean
machine" actually true rather than "deployable from *my* machine".

### Build command

```
npm install -g pnpm@10.27.0
  && pnpm install --frozen-lockfile --prod=false --ignore-scripts
  && pnpm run build:api
```

The pnpm version is not hard-coded — `main.tf` reads it out of the repo root's
`package.json` `packageManager` field with `jsondecode(file(...))`, so it
cannot drift from the version the lockfile was generated with.

Three non-obvious flags:

- **`--prod=false` is load-bearing.** Render exports `NODE_ENV` into the build
  environment, and pnpm drops `devDependencies` when it sees
  `NODE_ENV=production`. `typescript` is a devDependency, so without this the
  build dies with `tsc: not found`.
- **`--ignore-scripts`** skips the root `postinstall` (which shells out to a
  `comply` CLI that does not exist on a build host) and husky's `prepare`.
  Nothing needed for the build or the runtime has a meaningful install script.
- **`build:api`, not `pnpm --filter @ship/api build`.** The root script is
  `pnpm run build:shared && pnpm --filter @ship/api build`, and the
  `build:shared` half is mandatory. `shared/package.json` points `main` and
  `types` at `./dist`, so `@ship/shared` is consumed as *built output*, not as
  source — build the api alone and it fails to resolve the import.

`@ship/api`'s own build is `tsc && node scripts/copy-db-assets.mjs`. The
copier stages `src/db/schema.sql` and `src/db/migrations/` into `dist/`, which
`tsc` does not emit and the start command needs. (It is also the cross-platform
replacement for a POSIX `cp -r` — irrelevant on Render's Linux builders, but it
is the current script and it asserts the migration file count matches, so a
miscopy fails the build loudly.)

### Start command

```
node api/dist/db/migrate.js && node api/dist/index.js
```

Mirrors the `Dockerfile` CMD. `migrate.js` applies `api/src/db/schema.sql` —
the complete current DDL — before the numbered migrations, so a fresh database
lands on the right schema.

### ⚠️ `db:migrate` reports success when it has not finished

**Do not read the migration count as a health signal.** The `catch` block in
`api/src/db/migrate.ts` (~lines 103–111) wraps the *entire* migration loop and
swallows any error whose message contains `already exists`, printing
`Database schema already exists, continuing...` and exiting **0**. In practice
it applies **10 of the 47** files in `api/src/db/migrations/` and still reports
success.

A fresh Render database is still correct, because `schema.sql` is the complete
DDL and runs first. But incremental migrations against an existing database
are not trustworthy, and the exit code will not tell you. This is an
application defect, not a deployment one; it is called out here because the
deployment depends on it and the failure is silent.

### `NODE_ENV` is not `"production"` — on purpose

`api/src/index.ts` calls `loadProductionSecrets()` whenever
`NODE_ENV === 'production'`, and `api/src/config/ssm.ts` implements that by
reading five parameters out of **AWS SSM Parameter Store**
(`/ship/$ENVIRONMENT/{DATABASE_URL,SESSION_SECRET,CORS_ORIGIN,CDN_DOMAIN,APP_BASE_URL}`).

Off AWS there are no credentials and no parameters. The `Promise.all` rejects,
`main().catch()` calls `process.exit(1)`, and the container never binds a port.
The same call sits at the top of `api/src/db/migrate.ts`, so migrations die
first. The app is hard-coupled to AWS by the string `"production"`.

With any other value that path short-circuits and the API reads
`DATABASE_URL` / `SESSION_SECRET` / `CORS_ORIGIN` straight from the
environment — exactly what this config supplies. So `NODE_ENV` defaults to
`"staging"` (`var.node_env`).

**Stated plainly, this is a downgrade.** `NODE_ENV != "production"` also turns
off the session cookie `secure` flag in `api/src/app.ts` and the startup
assertion that `SESSION_SECRET` is set. The assertion is moot here because the
config sets `SESSION_SECRET` explicitly; the cookie flag is a real weakening,
and it is why this is a staging-grade deployment rather than a production one.

The right fix is in the app — make the secret source pluggable (env / SSM /
Render) instead of keying it off `NODE_ENV` — not in Terraform. Until then,
**Ship cannot run in production mode anywhere except AWS.**

---

## Secrets

- `RENDER_API_KEY` is read from the environment by the provider. It is not in
  any `.tf` file, any `.tfvars` file, or any commit.
- `SESSION_SECRET` uses `generate_value = true` — Render mints it. It is never
  in the config and no human ever sees it.
- `DATABASE_URL` is Render's **private-network** connection string, read back
  from the API at apply time. The database has no `ip_allow_list`, so it has no
  public ingress at all; only services in the same workspace and region can
  reach it.
- Both land in `terraform.tfstate`, which is why state stays local and
  gitignored (`terraform/.gitignore`). Anyone wiring this into CI needs a
  remote backend with encryption, the way the AWS stack does.

## Cost

Both plans default to `free`. Free Postgres is capped at one instance per
workspace and **is deleted 30 days after creation** — the one created on
2026-07-28 expires **2026-08-27**. Free web services spin down after ~15
minutes idle, so the first request after a quiet period takes roughly 50
seconds. Set `-var postgres_plan=basic_256mb -var web_service_plan=starter`
for anything that needs to stay up.

## Teardown

```bash
cd terraform/render
terraform destroy
```
