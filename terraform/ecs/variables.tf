variable "project_name" {
  description = "Name prefix for every resource in this stack."
  type        = string
  default     = "ship"
}

variable "environment" {
  description = "Environment this topology describes."
  type        = string
  default     = "prod"
}

variable "aws_region" {
  description = "Region for the stack."
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "CIDR for the VPC the service runs in."
  type        = string
  default     = "10.20.0.0/16"
}

variable "az_count" {
  description = "How many availability zones to spread subnets across."
  type        = number
  default     = 2
}

variable "container_image" {
  description = <<-EOT
    Image for the app container. Defaults to the ECR repository this stack
    declares, at the `latest` tag, so a plan is self-contained. A real deploy
    pins an immutable digest — `latest` is convenient and is exactly how a
    rollback becomes impossible.
  EOT
  type        = string
  default     = null
}

variable "container_port" {
  description = "Port the API listens on inside the container."
  type        = number
  default     = 3000
}

variable "desired_count" {
  description = "Number of tasks the service keeps running."
  type        = number
  default     = 2
}

variable "task_cpu" {
  description = "Fargate task CPU units (1024 = 1 vCPU)."
  type        = string
  default     = "512"
}

variable "task_memory" {
  description = "Fargate task memory (MiB). Must be a legal pair with task_cpu."
  type        = string
  default     = "1024"
}

variable "db_instance_class" {
  description = "Instance class for the managed Postgres the app talks to."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "ship"
}

variable "db_username" {
  description = "Master username. The password is never declared here — it is generated and stored in Secrets Manager."
  type        = string
  default     = "ship"
}

variable "log_retention_days" {
  description = "CloudWatch retention for the app container's log group."
  type        = number
  default     = 30
}
