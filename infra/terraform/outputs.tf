# What the app's Deployment needs as environment variables.
output "sqs_queue_url" {
  description = "SQS_QUEUE_URL for the app."
  value       = aws_sqs_queue.events.url
}

output "sqs_dlq_url" {
  description = "Dead-letter queue, to inspect and redrive failed events."
  value       = aws_sqs_queue.events_dlq.url
}

output "idempotency_table" {
  description = "DynamoDB table for idempotency keys."
  value       = aws_dynamodb_table.idempotency.name
}

output "idempotency_ttl_hours" {
  description = "TTL the app should use when writing expires_at."
  value       = var.idempotency_ttl_hours
}

output "cluster_name" {
  description = "aws eks update-kubeconfig --name <this>"
  value       = module.eks.cluster_name
}

output "app_service_account" {
  description = "The Deployment must run as this ServiceAccount to get the app role."
  value       = "${local.app_namespace}/${local.app_service_account}"
}

output "app_role_arn" {
  description = "IAM role the app's pods assume through EKS Pod Identity."
  value       = aws_iam_role.app.arn
}
