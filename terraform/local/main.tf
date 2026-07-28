##############################################################################
# Terraform — hashicorp/local provider
#
# Purpose: a self-contained configuration that manages two real local
# resources so drift detection can be demonstrated end-to-end without any
# cloud credentials. Nothing here touches the AWS stack in terraform/*.tf.
#
# Run ./run-drift-demo.sh to reproduce the captured evidence in ./out/.
##############################################################################

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    local = {
      source = "hashicorp/local"
      # Exact pin (not ~>) so every machine resolves the same provider build.
      # The committed .terraform.lock.hcl records the checksums.
      version = "2.5.2"
    }
  }
}

provider "local" {}

# Managed resource #1 — the file we tamper with out-of-band to create drift.
resource "local_file" "config" {
  filename        = "${path.module}/managed/app-config.json"
  file_permission = "0644"

  content = jsonencode({
    service  = "ship-api"
    env      = "drift-demo"
    replicas = 2
    logLevel = "info"
  })
}

# Managed resource #2 — left untouched. Proves Terraform reports drift only on
# the resource that actually changed rather than blanket-replacing everything.
resource "local_file" "readme" {
  filename        = "${path.module}/managed/README.txt"
  file_permission = "0644"

  content = <<-EOT
    This file is managed by Terraform (hashicorp/local).
    Do not edit by hand - Terraform will detect and revert changes.
  EOT
}

output "managed_files" {
  description = "Paths of the Terraform-managed files"
  value = [
    local_file.config.filename,
    local_file.readme.filename,
  ]
}

output "config_sha" {
  description = "Checksum Terraform recorded for the config file"
  value       = local_file.config.content_sha256
}
