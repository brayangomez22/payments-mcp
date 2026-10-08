variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Prefix for every resource name."
  type        = string
  default     = "payments-mcp"
}

variable "environment" {
  description = "dev, staging or prod. prod turns on the protections that cost money or slow down teardown."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "vpc_cidr" {
  description = "Address space of the VPC."
  type        = string
  default     = "10.40.0.0/16"
}

variable "kubernetes_version" {
  description = "EKS control plane version. Check the versions in standard support before changing it."
  type        = string
  default     = "1.34"
}

variable "node_instance_types" {
  description = "Instance types for the managed node group."
  type        = list(string)
  default     = ["t3.medium"]
}

variable "node_count" {
  description = "Min, desired and max nodes of the managed node group."
  type = object({
    min     = number
    desired = number
    max     = number
  })
  default = { min = 1, desired = 2, max = 3 }
}

variable "idempotency_ttl_hours" {
  description = "How long the app keeps idempotency keys. The app writes expires_at = now + this; DynamoDB deletes them after."
  type        = number
  default     = 24
}
