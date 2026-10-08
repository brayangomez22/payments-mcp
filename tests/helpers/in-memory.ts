import type { OutboxMessage } from '../../src/core/events/outbox.js';
import type { BeginResult, IdempotencyScope, IdempotencyStore } from '../../src/core/idempotency/idempotency.js';
import type { PaymentRepository, PaymentStore } from '../../src/features/payments/payment.repository.js';
import type { ListFilter, Payment, Refund } from '../../src/features/payments/payment.types.js';

class InMemoryPaymentRepository implements PaymentRepository {
  constructor(
    readonly payments: Map<string, Payment>,
    readonly refunds: Refund[],
    readonly events: OutboxMessage[],
  ) {}

  async insert(p: Payment): Promise<void> {
    this.payments.set(p.id, { ...p });
  }
  async update(p: Payment): Promise<void> {
    this.payments.set(p.id, { ...p });
  }
  async findById(merchantId: string, id: string): Promise<Payment | null> {
    const p = this.payments.get(id);
    return p && p.merchantId === merchantId ? { ...p } : null;
  }
  findByIdForUpdate(merchantId: string, id: string): Promise<Payment | null> {
    return this.findById(merchantId, id);
  }
  async list(merchantId: string, { status, limit, after }: ListFilter): Promise<Payment[]> {
    return [...this.payments.values()]
      .filter((p) => p.merchantId === merchantId && (!status || p.status === status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .filter(
        (p) =>
          !after ||
          p.createdAt.getTime() < after.createdAt.getTime() ||
          (p.createdAt.getTime() === after.createdAt.getTime() && p.id < after.id),
      )
      .slice(0, limit);
  }
  async insertRefund(r: Refund): Promise<void> {
    this.refunds.push({ ...r });
  }
  async appendEvent(e: OutboxMessage): Promise<void> {
    this.events.push(structuredClone(e));
  }
}

/** Transactions are serialized through a promise chain, mimicking the row lock. No rollback. */
export class InMemoryPaymentStore implements PaymentStore {
  readonly payments = new Map<string, Payment>();
  readonly refunds: Refund[] = [];
  readonly events: OutboxMessage[] = [];
  readonly repo = new InMemoryPaymentRepository(this.payments, this.refunds, this.events);
  private queue: Promise<unknown> = Promise.resolve();

  withTransaction<T>(fn: (repo: PaymentRepository) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn(this.repo));
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly entries = new Map<string, { fingerprint: string; response?: unknown }>();

  async begin({ merchantId, key, fingerprint }: IdempotencyScope): Promise<BeginResult> {
    const id = `${merchantId}:${key}`;
    const entry = this.entries.get(id);
    if (!entry) {
      this.entries.set(id, { fingerprint });
      return { state: 'new' };
    }
    if (entry.fingerprint !== fingerprint) return { state: 'mismatch' };
    if (!('response' in entry)) return { state: 'in_progress' };
    return { state: 'replay', response: structuredClone(entry.response) };
  }
  async complete({ merchantId, key }: IdempotencyScope, response: unknown): Promise<void> {
    const entry = this.entries.get(`${merchantId}:${key}`);
    if (entry) entry.response = structuredClone(response);
  }
  async release({ merchantId, key }: IdempotencyScope): Promise<void> {
    this.entries.delete(`${merchantId}:${key}`);
  }
}
