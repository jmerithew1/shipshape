output "api_url" {
  description = "Public URL of the deployed Ship API."
  value       = render_web_service.api.url
}

output "health_check_url" {
  description = "Liveness endpoint. Should return 200 {\"status\":\"ok\"}."
  value       = "${render_web_service.api.url}/health"
}

output "api_docs_url" {
  description = "Swagger UI served by the API."
  value       = "${render_web_service.api.url}/api/docs/"
}

output "web_service_id" {
  description = "Render service ID (srv-...), for `render`/API calls and log lookups."
  value       = render_web_service.api.id
}

output "postgres_id" {
  description = "Render Postgres instance ID (dpg-...)."
  value       = render_postgres.ship.id
}

output "project_id" {
  description = "Render project ID (prj-...)."
  value       = render_project.ship.id
}

# Deliberately NOT output: render_postgres.ship.connection_info. It contains
# the database password. It is already in state; there is no reason to also
# print it to a terminal or a CI log.
