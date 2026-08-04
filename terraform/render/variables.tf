variable "render_owner_id" {
  description = <<-EOT
    Render workspace (owner) ID that owns the created resources, e.g.
    "tea-xxxxxxxxxxxxxxxxxxxx". Leave null to let the provider read the
    RENDER_OWNER_ID environment variable instead. Find it with:
      curl -H "Authorization: Bearer $RENDER_API_KEY" https://api.render.com/v1/owners
  EOT
  type        = string
  default     = null
}

variable "service_name" {
  description = "Name of the Render web service running the Ship API."
  type        = string
  default     = "ship-api"
}

variable "database_name_prefix" {
  description = "Name of the Render Postgres instance."
  type        = string
  default     = "ship-db"
}

variable "region" {
  description = <<-EOT
    Render region for both the web service and the database. They MUST match:
    the API reaches Postgres over Render's private network, and the internal
    connection string only resolves within a single region.
    One of: frankfurt, ohio, oregon, singapore, virginia.
  EOT
  type        = string
  default     = "oregon"

  validation {
    condition     = contains(["frankfurt", "ohio", "oregon", "singapore", "virginia"], var.region)
    error_message = "region must be one of: frankfurt, ohio, oregon, singapore, virginia."
  }
}

variable "web_service_plan" {
  description = <<-EOT
    Render instance plan for the web service. "free" costs nothing but spins
    down after ~15 minutes of inactivity (first request after that takes
    ~50s). Paid plans documented by the provider: starter, standard, pro,
    pro_plus, pro_max, pro_ultra.

    Week 5: default is "starter" (~$7/mo) and this is LOAD-BEARING, not an
    optimization — FleetGraph's proactive mode runs on an in-process cron,
    and on the free tier node-cron does not run at all while the service is
    idled, so the agent's "runs without a user present" guarantee (and the
    graded <5-minute detection window) silently dies. Decision + sign-off:
    DECISIONS.md 2026-08-03 "Render Starter tier".
  EOT
  type        = string
  default     = "starter"
}

variable "postgres_plan" {
  description = <<-EOT
    Render Postgres plan. "free" is capped at one instance per workspace and
    is deleted 30 days after creation — fine for a demo/staging deployment,
    not for anything that must survive. Paid: basic_256mb, basic_1gb,
    pro_4gb, etc.
  EOT
  type        = string
  default     = "free"
}

variable "postgres_version" {
  description = "PostgreSQL major version. 16 matches docker-compose.local.yml (postgres:16)."
  type        = string
  default     = "16"
}

variable "repo_url" {
  description = <<-EOT
    Git repository Render builds from.

    ⚠️ BLOCKER — Render will only fetch from github.com or gitlab.com. The
    default below is this fork's actual origin, a self-hosted GitLab, and
    Render rejects it. Verified against the live API on 2026-07-28:

      Could not create service, unexpected error: could not create service:
      passed in repository URL is invalid or unfetchable:
      https://labs.gauntletai.com/jamesmerithew/shipshape. Accepted formats
      are: https://github.com/{namespace}/{repository} or
      https://gitlab.com/{namespace}/{repository}.

    Anonymous cloneability is not the issue — `git ls-remote` against the
    default URL succeeds without credentials. Render allowlists the two hosts
    regardless.

    To deploy: mirror this fork to github.com or gitlab.com, then

      terraform apply -var repo_url=https://github.com/<you>/shipshape

    Nothing else in this config needs to change. See docs/deployment-render.md.
  EOT
  type        = string
  default     = "https://labs.gauntletai.com/jamesmerithew/shipshape"
}

variable "branch" {
  description = "Branch Render builds and auto-deploys."
  type        = string
  default     = "main"
}

variable "node_version" {
  description = <<-EOT
    Node major version for Render's native runtime. 20 matches
    package.json engines (>=20) and the repo Dockerfile (node:20-slim).
  EOT
  type        = string
  default     = "20"
}

variable "node_env" {
  description = <<-EOT
    Value of the NODE_ENV environment variable.

    DELIBERATELY NOT "production". api/src/index.ts calls
    loadProductionSecrets() whenever NODE_ENV === "production", and
    api/src/config/ssm.ts implements that by reading five parameters out of
    AWS SSM Parameter Store (/ship/$ENVIRONMENT/DATABASE_URL, SESSION_SECRET,
    CORS_ORIGIN, CDN_DOMAIN, APP_BASE_URL). Off AWS there are no credentials
    and no parameters, the Promise.all rejects, main().catch() calls
    process.exit(1), and the container never binds a port. The same call sits
    at the top of api/src/db/migrate.ts.

    With any other value that code path short-circuits and the API reads
    DATABASE_URL / SESSION_SECRET / CORS_ORIGIN straight from the environment,
    which is exactly what this config supplies.

    Trade-off, stated plainly: NODE_ENV != "production" also turns off the
    session cookie `secure` flag (api/src/app.ts) and the startup assertion
    that SESSION_SECRET is set. This config sets SESSION_SECRET explicitly, so
    the assertion is moot; the cookie flag is a real downgrade and is the
    reason this is a staging-grade deployment. The fix belongs in the app —
    make the secret source pluggable instead of keying it off NODE_ENV — not
    in Terraform. See docs/deployment-render.md.
  EOT
  type        = string
  default     = "staging"
}

variable "anthropic_api_key" {
  description = <<-EOT
    Anthropic API key for FleetGraph's reasoning model (Week 5). Supplied via
    TF_VAR_anthropic_api_key at plan/apply time — never committed. Lands in
    local gitignored state, same posture as DATABASE_URL. Without it the
    agent runs rule-based-only (degraded mode is a designed behavior, not a
    crash) — but MVP tracing requires the real model.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "langsmith_api_key" {
  description = "LangSmith API key for tracing (Week 5). Same handling as anthropic_api_key."
  type        = string
  sensitive   = true
  default     = ""
}

variable "langsmith_project" {
  description = "LangSmith project name traces are written to."
  type        = string
  default     = "fleetgraph"
}

variable "fleetgraph_sweep_minutes" {
  description = <<-EOT
    FleetGraph sweep interval in minutes. SQL-only when quiet, so a tight
    default is effectively free; it is the backstop for the graded
    <5-minute detection window (FLEETGRAPH.md §Trigger Model).
  EOT
  type        = string
  default     = "2"
}

variable "cors_origin" {
  description = <<-EOT
    Origin allowed by the API's CORS middleware — the deployed web frontend's
    URL. This config deploys the API tier only; point this at wherever the
    web bundle is served from.
  EOT
  type        = string
  default     = "http://localhost:5173"
}
