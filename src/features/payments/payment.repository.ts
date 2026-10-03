import type { ListFilter, Payment, Refund } from './payment.types.js';

export interface PaymentRepository {
  insert(payment: Payment): Promise<void>;
  update(payment: Payment): Promise<void>;
  /** Scoped by merchant: another merchant's payment is indistinguishable from a missing one. */
  findById(merchantId: string, id: string): Promise<Payment | null>;
  /** Same as findById but locks the row until the surrounding transaction ends. */
  findByIdForUpdate(merchantId: string, id: string): Promise<Payment | null>;
  list(merchantId: string, filter: ListFilter): Promise<Payment[]>;
  insertRefund(refund: Refund): Promise<void>;
}

/** Unit of work: `repo` for plain reads/writes, `withTransaction` for multi-step atomic changes. */
export interface PaymentStore {
  readonly repo: PaymentRepository;
  withTransaction<T>(fn: (repo: PaymentRepository) => Promise<T>): Promise<T>;
}
