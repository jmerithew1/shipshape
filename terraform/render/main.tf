##############################################################################
# Ship — Render deployment
#
# Declares the whole API tier: a Render project/environment, a managed
# Postgres instance, and a web service that builds this fork from git and
# serves it. Replaces the manual deploy steps in DEPLOYMENT.md — from a clean
# machine, `export RENDER_API_KEY=... && terraform init && terraform apply`
# is the entire deployment.
#
# Provider version is pinned exactly in versions.tf. Nothing here reads or
# writes the AWS stack in terraform/*.tf; the two are independent.
##############################################################################

locals {
  # Sourced from the repo root so the build can never pin a pnpm version that
  # has drifted from the one the lockfile was generated with.
  # package.json -> "packageManager": "pnpm@10.27.0"
  pnpm_spec = jsondecode(file("${path.module}/../../package.json")).packageManager

  # Build steps, in the order the monorepo actually requires:
  #
  #   1. install pnpm  — Render's native Node runtime ships npm, not pnpm.
  #   2. pnpm install  — --prod=false is load-bearing. Render exports NODE_ENV
  #                      into the build, and pnpm drops devDependencies when
  #                      it sees NODE_ENV=production; typescript is a
  #                      devDependency, so the build would fail with "tsc:
  #                      not found". --ignore-scripts skips the repo's
  #                      postinstall (a `comply` CLI check) and husky's
  #                      prepare, neither of which exists or matters on a
  #                      build host.
  #   3. build:api     — root script, defined as
  #                      "pnpm run build:shared && pnpm --filter @ship/api build".
  #                      The build:shared half is mandatory: api imports
  #                      @ship/shared, whose package.json points main/types at
  #                      ./dist, so shared is consumed as *built output*, not
  #                      as source. Running only build:api's tsc step fails to
  #                      resolve @ship/shared.
  #                      @ship/api's own build is "tsc && node
  #                      scripts/copy-db-assets.mjs" — the copier stages
  #                      src/db/schema.sql and src/db/migrations/ into dist/,
  #                      which tsc does not emit and the start command needs.
  build_command = join(" && ", [
    "npm install -g ${local.pnpm_spec}",
    "pnpm install --frozen-lockfile --prod=false --ignore-scripts",
    # Full build (shared + api + web), not build:api: the API serves web/dist
    # itself (SERVE_WEB below), making this single service the whole app.
    # web's build bakes VITE_API_URL= (empty) so the SPA calls the API
    # same-origin — no CORS, no hostname baked at build time.
    "pnpm run build",
  ])

  # Mirrors the repo Dockerfile's CMD: migrate, then serve. migrate.js applies
  # api/src/db/schema.sql (the complete current DDL) before the numbered
  # migrations, so a fresh database lands on the right schema.
  #
  # KNOWN DEFECT, do not read the migration count as success: the catch block
  # in api/src/db/migrate.ts (~lines 103-111) wraps the *entire* migration
  # loop and swallows any error whose message contains "already exists",
  # printing "Database schema already exists, continuing..." and exiting 0.
  # In practice it applies 10 of the 47 files in api/src/db/migrations/ and
  # still reports success. Fresh databases are correct because schema.sql is
  # complete; incremental migrations are not to be trusted. See
  # docs/deployment-render.md.
  start_command = "node api/dist/db/migrate.js && node api/dist/index.js"
}

# ---------------------------------------------------------------------------
# Project + environment — groups the service and its database so they are
# visible as one unit in the Render dashboard rather than two loose resources.
# ---------------------------------------------------------------------------
resource "render_project" "ship" {
  name = "ship"

  environments = {
    "staging" = {
      name             = "staging"
      protected_status = "unprotected"
    }
  }
}

# ---------------------------------------------------------------------------
# Postgres — the API's only stateful dependency.
# Same region as the web service so the private-network connection string
# resolves.
# ---------------------------------------------------------------------------
resource "render_postgres" "ship" {
  name           = var.database_name_prefix
  plan           = var.postgres_plan
  region         = var.region
  version        = var.postgres_version
  environment_id = render_project.ship.environments["staging"].id

  # Match docker-compose.local.yml so local and deployed schemas are reached
  # by the same DDL under the same names.
  database_name = "ship_dev"
  database_user = "ship"

  # No ip_allow_list => no public ingress. The database is reachable only over
  # Render's private network, i.e. only from services in this workspace.
  # Deliberate: nothing outside the platform needs to talk to it.
}

# ---------------------------------------------------------------------------
# Web service — builds this fork from git and runs the Express API.
#
# Native Node runtime, NOT runtime_source.docker. The repo's Dockerfile is not
# self-contained: it does `COPY shared/dist/ ./shared/dist/` and
# `COPY api/dist/ ./api/dist/`, but `dist` is in .gitignore, so those paths do
# not exist in a fresh clone. It only works when the image is built on a host
# that has already run the build. Render builds from a clean checkout, so the
# COPY would fail. The native runtime runs the real build on Render instead,
# which is what makes "deployable from a clean machine" true.
# ---------------------------------------------------------------------------
resource "render_web_service" "api" {
  name              = var.service_name
  plan              = var.web_service_plan
  region            = var.region
  environment_id    = render_project.ship.environments["staging"].id
  health_check_path = "/health"
  start_command     = local.start_command

  runtime_source = {
    native_runtime = {
      runtime       = "node"
      repo_url      = var.repo_url
      branch        = var.branch
      build_command = local.build_command
      auto_deploy   = true
    }
  }

  env_vars = {
    # Private-network DSN for the instance above. Never leaves Render, and is
    # never written to a .tf or .tfvars file — Terraform reads it back from
    # the API at apply time. It does land in state, which is why state stays
    # local and gitignored (see terraform/.gitignore).
    "DATABASE_URL" = { value = render_postgres.ship.connection_info.internal_connection_string }

    # Let Render mint the session secret. It is never in the config, never in
    # a commit, and no human ever sees it.
    "SESSION_SECRET" = { generate_value = true }

    "CORS_ORIGIN" = { value = var.cors_origin }

    # See variables.tf for why this is not "production".
    "NODE_ENV" = { value = var.node_env }

    # Render routes external traffic to whatever port the service binds.
    # api/src/index.ts reads PORT (defaults to 3000); 10000 is Render's
    # convention.
    "PORT" = { value = "10000" }

    # Serve the built SPA from the API (api/src/app.ts, mounted after all
    # /api routes). WEB_DIST_PATH is relative to the start command's cwd —
    # the repo root — because app.ts's default ("../web/dist") assumes a
    # cwd of api/, which is not how the start command runs here.
    "SERVE_WEB"     = { value = "true" }
    "WEB_DIST_PATH" = { value = "web/dist" }

    # Pins the runtime Node major to package.json's engines (>=20) and the
    # Dockerfile's node:20-slim, instead of drifting with Render's default.
    "NODE_VERSION" = { value = var.node_version }
  }
}
