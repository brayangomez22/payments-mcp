import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/core/errors.js';
import { createService, tickingClock } from './helpers/fixtures.js';

const merchant = { merchantId: 'm_1' };
const other = { merchantId: 'm_2' };

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof AppError && err.code === code);
}

describe('PaymentService.create', () => {
  it('charges and returns a succeeded payment (1.1)', async () => {
    const { service, provider } = createService();
    const p = await service.create(merchant, { amountMinor: 150_000, currency: 'COP' }, 'key-00000001');
    assert.equal(p.status, 'succeeded');
    assert.equal(p.amountMinor, 150_000);
    assert.equal(p.description, null);
    assert.equal(provider.calls.charge, 1);
  });

  it('stores a declined charge as failed with a reason (1.6)', async () => {
    const { service } = createService();
    const p = await service.create(merchant, { amountMinor: 1013, currency: 'USD' }, 'key-00000001');
    assert.equal(p.status, 'failed');
    assert.equal(p.failureReason, 'card_declined');
  });

  it('leaves the payment pending when the provider times out (1.7)', async () => {
    const { service, store } = createService({ providerTimeoutMs: 10 });
    const p = await service.create(merchant, { amountMinor: 1099, currency: 'USD' }, 'key-00000001');
    assert.equal(p.status, 'pending');
    assert.equal(store.payments.get(p.id)?.status, 'pending');
  });

  it('replays the original result for the same key and body without charging again (1.3)', async () => {
    const { service, provider } = createService();
    const input = { amountMinor: 5000, currency: 'COP' as const, description: 'order 1' };
    const first = await service.create(merchant, input, 'key-00000001');
    const second = await service.create(merchant, { ...input }, 'key-00000001');
    assert.deepEqual(second, first);
    assert.equal(provider.calls.charge, 1);
  });

  it('rejects the same key with a different body (1.4)', async () => {
    const { service } = createService();
    await service.create(merchant, { amountMinor: 5000, currency: 'COP' }, 'key-00000001');
    await rejectsWith(service.create(merchant, { amountMinor: 6000, currency: 'COP' }, 'key-00000001'), 'IDEMPOTENCY_KEY_REUSED');
  });

  it('scopes idempotency keys per merchant', async () => {
    const { service, provider } = createService();
    await service.create(merchant, { amountMinor: 5000, currency: 'COP' }, 'key-00000001');
    await service.create(other, { amountMinor: 5000, currency: 'COP' }, 'key-00000001');
    assert.equal(provider.calls.charge, 2);
  });

  it('reports a concurrent duplicate as in progress', async () => {
    const { service } = createService({ providerTimeoutMs: 30 });
    const slow = service.create(merchant, { amountMinor: 1099, currency: 'USD' }, 'key-00000001');
    await rejectsWith(service.create(merchant, { amountMinor: 1099, currency: 'USD' }, 'key-00000001'), 'REQUEST_IN_PROGRESS');
    await slow;
  });

  it('releases the key when the operation throws, so the client can retry', async () => {
    const { service, store, idempotency } = createService();
    store.repo.insert = async () => {
      throw new Error('db down');
    };
    await assert.rejects(service.create(merchant, { amountMinor: 5000, currency: 'COP' }, 'key-00000001'));
    assert.equal(idempotency.entries.size, 0);
  });
});

describe('PaymentService.get', () => {
  it('returns the payment of the calling merchant (2.1)', async () => {
    const { service } = createService();
    const created = await service.create(merchant, { amountMinor: 5000, currency: 'COP' }, 'key-00000001');
    assert.deepEqual(await service.get(merchant, created.id), created);
  });

  it("hides another merchant's payment as not found (2.2)", async () => {
    const { service } = createService();
    const created = await service.create(merchant, { amountMinor: 5000, currency: 'COP' }, 'key-00000001');
    await rejectsWith(service.get(other, created.id), 'PAYMENT_NOT_FOUND');
  });
});

describe('PaymentService.list', () => {
  it('paginates newest first with an opaque cursor (2.3)', async () => {
    const { service } = createService({ clock: tickingClock() });
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push((await service.create(merchant, { amountMinor: i * 100, currency: 'COP' }, `key-0000000${i}`)).id);
    }
    await service.create(other, { amountMinor: 100, currency: 'COP' }, 'key-other-1');

    const page1 = await service.list(merchant, { limit: 2 });
    assert.deepEqual(page1.data.map((p) => p.id), [ids[4], ids[3]]);
    assert.ok(page1.nextCursor);

    const page2 = await service.list(merchant, { limit: 2, cursor: page1.nextCursor });
    assert.deepEqual(page2.data.map((p) => p.id), [ids[2], ids[1]]);

    const page3 = await service.list(merchant, { limit: 2, cursor: page2.nextCursor ?? '' });
    assert.deepEqual(page3.data.map((p) => p.id), [ids[0]]);
    assert.equal(page3.nextCursor, null);
  });

  it('filters by status', async () => {
    const { service } = createService({ clock: tickingClock() });
    await service.create(merchant, { amountMinor: 100, currency: 'COP' }, 'key-00000001');
    await service.create(merchant, { amountMinor: 113, currency: 'COP' }, 'key-00000002');
    const page = await service.list(merchant, { limit: 10, status: 'failed' });
    assert.deepEqual(page.data.map((p) => p.amountMinor), [113]);
  });

  it('rejects a malformed cursor', async () => {
    const { service } = createService();
    await rejectsWith(service.list(merchant, { limit: 10, cursor: 'not-a-cursor' }), 'INVALID_CURSOR');
  });
});

describe('PaymentService.refund', () => {
  async function succeededPayment(amountMinor = 10_000) {
    const ctx = createService();
    const payment = await ctx.service.create(merchant, { amountMinor, currency: 'COP' }, 'key-pay-0001');
    return { ...ctx, payment };
  }

  it('partially and then fully refunds a payment (3.1)', async () => {
    const { service, payment, store } = await succeededPayment();
    const r1 = await service.refund(merchant, payment.id, { amountMinor: 4000 }, 'key-ref-0001');
    assert.equal(r1.payment.status, 'partially_refunded');
    assert.equal(r1.payment.refundedMinor, 4000);

    const r2 = await service.refund(merchant, payment.id, { amountMinor: 6000 }, 'key-ref-0002');
    assert.equal(r2.payment.status, 'refunded');
    assert.equal(store.refunds.length, 2);
  });

  it('rejects refunds above the remaining amount (3.2)', async () => {
    const { service, payment } = await succeededPayment();
    await service.refund(merchant, payment.id, { amountMinor: 7000 }, 'key-ref-0001');
    await rejectsWith(service.refund(merchant, payment.id, { amountMinor: 3001 }, 'key-ref-0002'), 'REFUND_EXCEEDS_AMOUNT');
  });

  it('rejects refunds on payments that are not refundable (3.3)', async () => {
    const { service } = createService();
    const failed = await service.create(merchant, { amountMinor: 1013, currency: 'COP' }, 'key-pay-0001');
    await rejectsWith(service.refund(merchant, failed.id, { amountMinor: 1 }, 'key-ref-0001'), 'PAYMENT_NOT_REFUNDABLE');
  });

  it('never over-refunds under concurrency (3.4)', async () => {
    const { service, payment, store } = await succeededPayment();
    const attempts = await Promise.allSettled(
      [1, 2, 3].map((i) => service.refund(merchant, payment.id, { amountMinor: 4000 }, `key-ref-000${i}`)),
    );
    assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 2);
    assert.equal(store.payments.get(payment.id)?.refundedMinor, 8000);
  });

  it('does not refund twice on an idempotent retry', async () => {
    const { service, payment, provider } = await succeededPayment();
    const first = await service.refund(merchant, payment.id, { amountMinor: 1000 }, 'key-ref-0001');
    const retry = await service.refund(merchant, payment.id, { amountMinor: 1000 }, 'key-ref-0001');
    assert.deepEqual(retry, first);
    assert.equal(provider.calls.refund, 1);
  });

  it('returns not found for another merchant (2.2)', async () => {
    const { service, payment } = await succeededPayment();
    await rejectsWith(service.refund(other, payment.id, { amountMinor: 1 }, 'key-ref-0001'), 'PAYMENT_NOT_FOUND');
  });

  it('maps a provider failure to PROVIDER_UNAVAILABLE without changing the payment', async () => {
    const { service, payment, provider, store } = await succeededPayment();
    provider.refund = async () => {
      throw new Error('connection reset');
    };
    await rejectsWith(service.refund(merchant, payment.id, { amountMinor: 1000 }, 'key-ref-0001'), 'PROVIDER_UNAVAILABLE');
    assert.equal(store.payments.get(payment.id)?.refundedMinor, 0);
  });
});
