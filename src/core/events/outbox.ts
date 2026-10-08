/** An event to be written to the outbox, inside the transaction of the change it describes. */
export interface OutboxMessage {
  topic: string;
  payload: Record<string, unknown>;
}

/** A stored outbox row. `id` is a BIGSERIAL, kept as a string (node-postgres returns BIGINT as text). */
export interface OutboxEvent extends OutboxMessage {
  id: string;
}

/** Where the relay sends events (SQS in production). Resolves with the ids the broker accepted. */
export interface EventPublisher {
  publish(events: OutboxEvent[]): Promise<string[]>;
}

export interface DrainResult {
  claimed: number;
  published: number;
}

export interface OutboxStore {
  /**
   * In one transaction: lock up to `limit` pending events (skipping rows another relay holds),
   * hand them to `publish`, and mark the ids it returns as published. Ids it does not return
   * stay pending and are retried on a later pass.
   */
  drain(limit: number, publish: (events: OutboxEvent[]) => Promise<string[]>): Promise<DrainResult>;
}
