terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68"
    }
  }

  # Remote state: one bucket per account, one key per environment. Since Terraform 1.10 the S3
  # backend locks with a lock file in the bucket (use_lockfile): no DynamoDB lock table needed.
  # Left commented so `terraform init` works locally without AWS; enable it before a team uses it.
  #
  # backend "s3" {
  #   bucket       = "payments-mcp-tfstate"
  #   key          = "dev/terraform.tfstate"
  #   region       = "us-east-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region

  # Every resource gets these tags: cost reports and "who owns this?" without asking.
  default_tags {
    tags = local.tags
  }
}
