terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Exact pin (not ~>), matching the discipline in terraform/render and
      # terraform/local. The brief's wording is unambiguous: "Provider versions
      # must be pinned."
      version = "5.82.2"
    }

    # `random_password` pulls hashicorp/random. Declaring only `aws` left this
    # one to IMPLICIT inference at whatever version happened to resolve — which
    # is exactly the unpinned provider the brief forbids, hiding behind a
    # resource nobody thinks of as a dependency. Found by audit, 2026-08-16.
    random = {
      source  = "hashicorp/random"
      version = "3.9.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # PLAN-ONLY BY DESIGN.
  #
  # This configuration exists to describe the deployment topology in the
  # vocabulary the brief uses — "app container, database, networking, IAM task
  # role and execution role" — and to produce the annotated `terraform plan`
  # artifact it asks for. The live deployment is Render (terraform/render/),
  # which carries its own destroy-and-redeploy proof.
  #
  # These skips let `terraform plan` run without contacting AWS at all, so the
  # artifact is reproducible by anyone with a checkout and no credentials.
  # There are deliberately NO `data` sources in this stack for the same reason:
  # a single data lookup would reintroduce the API call these skips avoid.
  #
  # They affect planning only. An `apply` against a real account would still
  # authenticate normally.
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true

  access_key = "mock-access-key-plan-only"
  secret_key = "mock-secret-key-plan-only"

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Stack       = "ecs-topology"
    }
  }
}
