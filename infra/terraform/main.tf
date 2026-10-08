locals {
  name    = "${var.project}-${var.environment}"
  is_prod = var.environment == "prod"

  tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  # Kubernetes identity of the app: the ServiceAccount the Deployment runs as.
  app_namespace       = "payments"
  app_service_account = "payments-mcp"
}
