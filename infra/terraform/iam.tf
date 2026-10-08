# What the app's pods may do in AWS, and nothing else (least privilege).
# EKS Pod Identity: the pod's ServiceAccount is mapped to this role; the SDK picks the
# credentials up automatically. No AWS keys in env vars or Secrets.

data "aws_iam_policy_document" "app_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.name}-app"
  assume_role_policy = data.aws_iam_policy_document.app_trust.json
}

data "aws_iam_policy_document" "app" {
  # The outbox relay: SendMessageBatch is authorized by sqs:SendMessage.
  statement {
    sid       = "PublishPaymentEvents"
    actions   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.events.arn]
  }

  # Idempotency keys. No Scan, no table-level actions.
  statement {
    sid       = "IdempotencyKeys"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.idempotency.arn]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_eks_pod_identity_association" "app" {
  cluster_name    = module.eks.cluster_name
  namespace       = local.app_namespace
  service_account = local.app_service_account
  role_arn        = aws_iam_role.app.arn
}
