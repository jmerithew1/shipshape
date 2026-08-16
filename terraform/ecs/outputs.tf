output "cluster_name" {
  description = "ECS cluster running the app container."
  value       = aws_ecs_cluster.main.name
}

output "service_name" {
  description = "ECS service maintaining the desired task count."
  value       = aws_ecs_service.app.name
}

output "task_definition_arn" {
  description = "Task definition — the app container, its roles, and its secrets."
  value       = aws_ecs_task_definition.app.arn
}

output "execution_role_arn" {
  description = "Used by the ECS agent to pull the image and fetch secrets. Never assumed by the application."
  value       = aws_iam_role.execution.arn
}

output "task_role_arn" {
  description = "Assumed by the running application. Every AWS call the code makes is authorised by this role."
  value       = aws_iam_role.task.arn
}

output "database_endpoint" {
  description = "Managed Postgres endpoint the app connects to."
  value       = aws_db_instance.postgres.address
}

output "ecr_repository_url" {
  description = "Registry the app image is pulled from."
  value       = aws_ecr_repository.app.repository_url
}
