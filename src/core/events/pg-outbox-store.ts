import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type { DrainResult, OutboxEvent, OutboxStore } from './outbox.js';

export class PgOutboxStore implements OutboxStore {
  constructor(private readonly pool: Pool) {}

  drain(limit: number, publish: (events: OutboxEvent[]) => Promise<string[]>): Promise<DrainResult> {
    return withTransaction(this.pool, async (client) => {
      // SKIP LOCKED: several relays (one per pod) split the pending rows instead of waiting on each other.
      const { rows } = await client.query<OutboxEvent>(
        `SELECT id, topic, payload FROM outbox WHERE published_at IS NULL
         ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (rows.length === 0) return { claimed: 0, published: 0 };

      // The rows stay locked while we publish. If we crash after SQS accepted them but before
      // COMMIT, they are sent again: delivery is at-least-once and consumers dedupe by eventId.
      const published = await publish(rows);
      if (published.length > 0) {
        await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [published]);
      }
      return { claimed: rows.length, published: published.length };
    });
  }
}
