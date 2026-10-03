import type { Pool, Queryable } from '../../core/db/pool.js';
import { withTransaction } from '../../core/db/pool.js';
import type { PaymentRepository, PaymentStore } from './payment.repository.js';
import type { Currency, ListFilter, Payment, PaymentStatus, Refund } from './payment.types.js';

const COLUMNS = `id, merchant_id, amount_minor, currency, status, refunded_minor, description,
  provider_ref, failure_reason, created_at, updated_at`;

interface PaymentRow {
  id: string;
  merchant_id: string;
  amount_minor: string; // BIGINT arrives as string from node-postgres
  currency: Currency;
  status: PaymentStatus;
  refunded_minor: string;
  description: string | null;
  provider_ref: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PgPaymentRepository implements PaymentRepository {
  constructor(private readonly db: Queryable) {}

  async insert(p: Payment): Promise<void> {
    // created_at comes from the app (millisecond precision) so cursors round-trip exactly.
    await this.db.query(
      `INSERT INTO payments (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        p.id,
        p.merchantId,
        p.amountMinor,
        p.currency,
        p.status,
        p.refundedMinor,
        p.description,
        p.providerRef,
        p.failureReason,
        p.createdAt,
        p.updatedAt,
      ],
    );
  }

  async update(p: Payment): Promise<void> {
    await this.db.query(
      `UPDATE payments SET status = $2, refunded_minor = $3, provider_ref = $4, failure_reason = $5, updated_at = $6
       WHERE id = $1`,
      [p.id, p.status, p.refundedMinor, p.providerRef, p.failureReason, p.updatedAt],
    );
  }

  findById(merchantId: string, id: string): Promise<Payment | null> {
    return this.findOne(`SELECT ${COLUMNS} FROM payments WHERE id = $1 AND merchant_id = $2`, [id, merchantId]);
  }

  findByIdForUpdate(merchantId: string, id: string): Promise<Payment | null> {
    return this.findOne(`SELECT ${COLUMNS} FROM payments WHERE id = $1 AND merchant_id = $2 FOR UPDATE`, [
      id,
      merchantId,
    ]);
  }

  async list(merchantId: string, { status, limit, after }: ListFilter): Promise<Payment[]> {
    // Built dynamically instead of `($2 IS NULL OR status = $2)`: each shape gets its own
    // plan and can use the index whose prefix matches its predicates.
    const params: unknown[] = [merchantId];
    const where = ['merchant_id = $1'];
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (after) {
      params.push(after.createdAt, after.id);
      where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(limit);

    const { rows } = await this.db.query<PaymentRow>(
      `SELECT ${COLUMNS} FROM payments WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toPayment);
  }

  async insertRefund(r: Refund): Promise<void> {
    await this.db.query(
      'INSERT INTO refunds (id, payment_id, amount_minor, provider_ref, created_at) VALUES ($1, $2, $3, $4, $5)',
      [r.id, r.paymentId, r.amountMinor, r.providerRef, r.createdAt],
    );
  }

  private async findOne(sql: string, params: unknown[]): Promise<Payment | null> {
    const { rows } = await this.db.query<PaymentRow>(sql, params);
    return rows[0] ? toPayment(rows[0]) : null;
  }
}

export class PgPaymentStore implements PaymentStore {
  readonly repo: PaymentRepository;

  constructor(private readonly pool: Pool) {
    this.repo = new PgPaymentRepository(pool);
  }

  withTransaction<T>(fn: (repo: PaymentRepository) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, (client) => fn(new PgPaymentRepository(client)));
  }
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    refundedMinor: Number(row.refunded_minor),
    description: row.description,
    providerRef: row.provider_ref,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
