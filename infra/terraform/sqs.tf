# Payment events published by the outbox relay (same shape as localstack/init-sqs.sh).

resource "aws_sqs_queue" "events_dlq" {
  name                      = "${local.name}-events-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum: time to inspect and redrive
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "events" {
  name                       = "${local.name}-events"
  message_retention_seconds  = 345600 # 4 days
  visibility_timeout_seconds = 30     # a consumer has 30 s to process and delete before redelivery
  receive_wait_time_seconds  = 20     # long polling: fewer empty receives, lower cost
  sqs_managed_sse_enabled    = true

  # After 5 failed receives a message goes to the DLQ instead of blocking consumers forever.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.events_dlq.arn
    maxReceiveCount     = 5
  })
}

# Only the main queue may use this DLQ.
resource "aws_sqs_queue_redrive_allow_policy" "events_dlq" {
  queue_url = aws_sqs_queue.events_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.events.arn]
  })
}
