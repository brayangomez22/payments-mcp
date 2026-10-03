import type { Pool } from '../db/pool.js';
import type { BeginResult, IdempotencyScope, IdempotencyStore } from './idempotency.js';

export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async begin({ merchantId, key, fingerprint }: IdempotencyScope): Promise<BeginResult> {
    // The primary key is the lock: of N concurrent requests, exactly one inserts the row.
    const inserted = await this.pool.query(
      `INSERT INTO idempotency_keys (merchant_id, key, fingerprint) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [merchantId, key, fingerprint],
    );
    if (inserted.rowCount === 1) return { state: 'new' };

    const { rows } = await this.pool.query<{ fingerprint: string; response_body: unknown }>(
      'SELECT fingerprint, response_body FROM idempotency_keys WHERE merchant_id = $1 AND key = $2',
      [merchantId, key],
    );
    const row = rows[0];
    // Row vanished between INSERT and SELECT: the other request was released. Try again.
    if (!row) return this.begin({ merchantId, key, fingerprint });
    if (row.fingerprint !== fingerprint) return { state: 'mismatch' };
    if (row.response_body === null) return { state: 'in_progress' };
    return { state: 'replay', response: row.response_body };
  }

  async complete({ merchantId, key }: IdempotencyScope, response: unknown): Promise<void> {
    await this.pool.query('UPDATE idempotency_keys SET response_body = $3 WHERE merchant_id = $1 AND key = $2', [
      merchantId,
      key,
      JSON.stringify(response),
    ]);
  }

  async release({ merchantId, key }: IdempotencyScope): Promise<void> {
    await this.pool.query('DELETE FROM idempotency_keys WHERE merchant_id = $1 AND key = $2 AND response_body IS NULL', [
      merchantId,
      key,
    ]);
  }
}
