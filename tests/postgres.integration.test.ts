import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createPool, type Pool } from '../src/core/db/pool.js';
import { PgIdempotencyStore } from '../src/core/idempotency/pg-idempotency-store.js';
import { migrate } from '../src/db/migrate.js';
import { PaymentService } from '../src/features/payments/payment.service.js';
import { PgPaymentStore } from '../src/features/payments/pg-payment.repository.js';
import { FakeProvider } from '../src/integrations/provider/fake-provider.js';
import { silentLogger, tickingClock } from './helpers/fixtures.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const pool: Pool | undefined = DATABASE_URL ? createPool(DATABASE_URL) : undefined;
const reachable = await pool?.query('SELECT 1').then(() => true, () => false);

describe('Postgres integration', { skip: !reachable && 'DATABASE_URL not set or database unreachable' }, () => {
  const db = pool as Pool;
  const merchant = { merchantId: `m_${crypto.randomUUID()}` };
  let service: PaymentService;

  before(async () => {
    await migrate(db);
    service = new PaymentService({
      store: new PgPaymentStore(db),
      idempotency: new PgIdempotencyStore(db),
      provider: new FakeProvider(),
      logger: silentLogger,
      providerTimeoutMs: 50,
      clock: tickingClock(),
    });
  });
  after(() => db.end());

  it('migrations are idempotent', async () => {
    assert.deepEqual(await migrate(db), []);
  });

  it('creates, reads and paginates with keyset cursors', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push((await service.create(merchant, { amountMinor: i * 1000, currency: 'COP' }, `pg-key-${i}`)).id);
    }
    const created = await service.get(merchant, ids[0] ?? '');
    assert.equal(created.amountMinor, 1000); // BIGINT → number

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list(merchant, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.data.map((p) => p.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, [...ids].reverse());

    const failed = await service.list(merchant, { limit: 10, status: 'failed' });
    assert.equal(failed.data.length, 0);
  });

  it('replays idempotent creates from the database', async () => {
    const input = { amountMinor: 7000, currency: 'USD' as const };
    const first = await service.create(merchant, input, 'pg-replay-1');
    const again = await service.create(merchant, input, 'pg-replay-1');
    assert.deepEqual(again, first);
    await assert.rejects(service.create(merchant, { ...input, amountMinor: 1 }, 'pg-replay-1'), /different request/);
  });

  it('serializes concurrent refunds with SELECT … FOR UPDATE', async () => {
    const payment = await service.create(merchant, { amountMinor: 10_000, currency: 'COP' }, 'pg-refund-pay');
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) => service.refund(merchant, payment.id, { amountMinor: 4000 }, `pg-refund-${i}`)),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    const final = await service.get(merchant, payment.id);
    assert.equal(final.refundedMinor, 8000);
    assert.equal(final.status, 'partially_refunded');

    const { rows } = await db.query('SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1', [payment.id]);
    assert.equal(rows[0].n, 2);
  });

  it('rolls back the refund transaction when the provider fails', async () => {
    const store = new PgPaymentStore(db);
    const provider = new FakeProvider();
    provider.refund = async () => {
      throw new Error('boom');
    };
    const failing = new PaymentService({
      store,
      idempotency: new PgIdempotencyStore(db),
      provider,
      logger: silentLogger,
      providerTimeoutMs: 50,
    });
    const payment = await failing.create(merchant, { amountMinor: 500, currency: 'COP' }, 'pg-rollback-pay');
    await assert.rejects(failing.refund(merchant, payment.id, { amountMinor: 100 }, 'pg-rollback-ref'));
    assert.equal((await failing.get(merchant, payment.id)).refundedMinor, 0);
    // Key was released: the same request can be retried.
    const { rows } = await db.query('SELECT 1 FROM idempotency_keys WHERE key = $1', ['pg-rollback-ref']);
    assert.equal(rows.length, 0);
  });
});
