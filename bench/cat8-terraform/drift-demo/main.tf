terraform {
  required_version = ">= 1.6.0"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.2" # exact pin (not ~>) so the lock file is deterministic
    }
  }
}

provider "local" {}

# Managed file #1 - the one we will tamper with out-of-band to create drift.
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

# Managed file #2 - left untouched, proves Terraform reports drift only on the
# resource that actually changed rather than blanket-replacing everything.
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
