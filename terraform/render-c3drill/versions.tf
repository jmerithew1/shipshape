terraform {
  required_version = ">= 1.6.0"

  required_providers {
    render = {
      source = "render-oss/render"
      # Exact pin (not ~>), matching the discipline in terraform/local.
      # .terraform.lock.hcl is committed alongside it.
      version = "1.9.1"
    }
  }
}

provider "render" {
  # api_key is read from the RENDER_API_KEY environment variable and is
  # deliberately NOT declared here — no key ever lands in a .tf file, a
  # .tfvars file, or state.
  #
  #   export RENDER_API_KEY=...      # https://dashboard.render.com/settings#api-keys
  #
  # owner_id falls back to the RENDER_OWNER_ID environment variable when the
  # variable below is left null.
  owner_id = var.render_owner_id

  # Render's API applies service updates and redeploys them separately. Let
  # the provider trigger a deploy after a service change so `terraform apply`
  # is genuinely the whole deployment, not just a config write.
  skip_deploy_after_service_update = false

  # Block until the deploy finishes, so a green `apply` means a live service
  # rather than a queued build that may still fail.
  wait_for_deploy_completion = true
}
