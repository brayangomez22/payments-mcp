#!/bin/sh
# Runs inside LocalStack once it is ready. Main queue + DLQ: after 5 failed receives a message
# moves to the DLQ instead of blocking consumers forever.
set -e
awslocal sqs create-queue --queue-name payments-events-dlq
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url http://localhost:4566/000000000000/payments-events-dlq \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)
awslocal sqs create-queue --queue-name payments-events \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"
