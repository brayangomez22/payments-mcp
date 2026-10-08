# Idempotency keys, the "Fase 4" evolution in design.md: today they live in Postgres.
# Access pattern: get/put ONE key of ONE merchant → pk = MERCHANT#<id>, sk = KEY#<key>.
# The first request wins with PutItem + ConditionExpression attribute_not_exists(pk).

resource "aws_dynamodb_table" "idempotency" {
  name         = "${local.name}-idempotency"
  billing_mode = "PAY_PER_REQUEST" # no capacity planning; pay per request
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # The app writes expires_at (epoch SECONDS) = now + var.idempotency_ttl_hours. DynamoDB deletes
  # expired items in the background for free (usually within a few days, so reads must also check it).
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  deletion_protection_enabled = local.is_prod
}
