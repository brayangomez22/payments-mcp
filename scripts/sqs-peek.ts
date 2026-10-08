// Prints the payment events waiting in the queue (and deletes them). Usage: npm run sqs:peek
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const queueUrl = process.env['SQS_QUEUE_URL'];
if (!queueUrl) throw new Error('SQS_QUEUE_URL is not set');
const sqs = new SQSClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

const { Messages = [] } = await sqs.send(
  new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2, MessageAttributeNames: ['All'] }),
);
for (const m of Messages) {
  console.log(m.MessageAttributes?.['topic']?.StringValue, JSON.parse(m.Body ?? '{}'));
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
}
console.log(`${Messages.length} message(s)`);
