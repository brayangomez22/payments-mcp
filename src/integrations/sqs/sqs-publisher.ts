import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, OutboxEvent } from '../../core/events/outbox.js';

/** Publishes outbox events to one SQS queue. The topic travels as a message attribute for filtering. */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: Pick<SQSClient, 'send'>,
    private readonly queueUrl: string,
  ) {}

  async publish(events: OutboxEvent[]): Promise<string[]> {
    const output = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: this.queueUrl,
        // Entry Id only has to be unique within the batch; the outbox id is, and maps results back.
        Entries: events.map((e) => ({
          Id: e.id,
          MessageBody: JSON.stringify(e.payload),
          MessageAttributes: { topic: { DataType: 'String', StringValue: e.topic } },
        })),
      }),
    );
    // A batch can partially fail (output.Failed). Only the successful ids are marked as published.
    return (output.Successful ?? []).flatMap((s) => (s.Id ? [s.Id] : []));
  }
}
