import { randomUUID } from 'node:crypto';
import { Errors } from '../../core/errors.js';
import { fingerprint, runIdempotent, type IdempotencyStore } from '../../core/idempotency/idempotency.js';
import type { Logger } from '../../core/logger.js';
import type { ChargeResult, PaymentProvider } from '../../integrations/provider/payment-provider.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type { PaymentStore } from './payment.repository.js';
import type { CreatePaymentInput, ListPaymentsInput, RefundPaymentInput } from './payment.schemas.js';
import {
  REFUNDABLE_STATUSES,
  toPaymentView,
  toRefundView,
  type Payment,
  type PaymentPage,
  type PaymentView,
  type Refund,
  type RefundView,
} from './payment.types.js';

export interface MerchantContext {
  merchantId: string;
}

export interface PaymentServiceDeps {
  store: PaymentStore;
  provider: PaymentProvider;
  idempotency: IdempotencyStore;
  logger: Logger;
  providerTimeoutMs: number;
  clock?: () => Date;
}

export interface RefundOutcome {
  refund: RefundView;
  payment: PaymentView;
}

/** The only place with payment business rules. REST and MCP are thin adapters over it. */
export class PaymentService {
  private readonly clock: () => Date;

  constructor(private readonly deps: PaymentServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  create(ctx: MerchantContext, input: CreatePaymentInput, idempotencyKey: string): Promise<PaymentView> {
    const scope = {
      merchantId: ctx.merchantId,
      key: idempotencyKey,
      fingerprint: fingerprint('create_payment', input),
    };
    return runIdempotent(this.deps.idempotency, scope, async () => {
      const now = this.clock();
      const payment: Payment = {
        id: randomUUID(),
        merchantId: ctx.merchantId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: 'pending',
        refundedMinor: 0,
        description: input.description ?? null,
        providerRef: null,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      // Persist BEFORE calling the provider: if we crash mid-call, a pending row remains to reconcile.
      await this.deps.store.repo.insert(payment);

      const result = await this.charge(payment);
      if (!result) return toPaymentView(payment);

      const settled: Payment = {
        ...payment,
        status: result.status,
        providerRef: result.providerRef,
        failureReason: result.status === 'failed' ? result.failureReason : null,
        updatedAt: this.clock(),
      };
      await this.deps.store.repo.update(settled);
      return toPaymentView(settled);
    });
  }

  async get(ctx: MerchantContext, id: string): Promise<PaymentView> {
    const payment = await this.deps.store.repo.findById(ctx.merchantId, id);
    if (!payment) throw Errors.paymentNotFound();
    return toPaymentView(payment);
  }

  async list(ctx: MerchantContext, input: ListPaymentsInput): Promise<PaymentPage> {
    const after = input.cursor ? decodeCursor(input.cursor) : undefined;
    // Fetch one extra row to know whether another page exists without a COUNT(*).
    const rows = await this.deps.store.repo.list(ctx.merchantId, { status: input.status, limit: input.limit + 1, after });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      data: page.map(toPaymentView),
      nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
    };
  }

  refund(
    ctx: MerchantContext,
    paymentId: string,
    input: RefundPaymentInput,
    idempotencyKey: string,
  ): Promise<RefundOutcome> {
    const scope = {
      merchantId: ctx.merchantId,
      key: idempotencyKey,
      fingerprint: fingerprint('refund_payment', { paymentId, ...input }),
    };
    return runIdempotent(this.deps.idempotency, scope, () =>
      this.deps.store.withTransaction(async (repo) => {
        // Row lock: two concurrent refunds on the same payment are serialized here.
        const payment = await repo.findByIdForUpdate(ctx.merchantId, paymentId);
        if (!payment) throw Errors.paymentNotFound();
        if (!REFUNDABLE_STATUSES.has(payment.status) || !payment.providerRef) {
          throw Errors.paymentNotRefundable(payment.status);
        }
        const remaining = payment.amountMinor - payment.refundedMinor;
        if (input.amountMinor > remaining) throw Errors.refundExceedsAmount(remaining);

        const refundId = randomUUID();
        const { providerRef } = await this.deps.provider
          .refund(
            { providerRef: payment.providerRef, amountMinor: input.amountMinor, reference: refundId },
            AbortSignal.timeout(this.deps.providerTimeoutMs),
          )
          .catch((err: unknown) => {
            this.deps.logger.error({ err, paymentId }, 'provider refund failed');
            throw Errors.providerUnavailable();
          });

        const now = this.clock();
        const refund: Refund = { id: refundId, paymentId, amountMinor: input.amountMinor, providerRef, createdAt: now };
        const refundedMinor = payment.refundedMinor + input.amountMinor;
        const updated: Payment = {
          ...payment,
          refundedMinor,
          status: refundedMinor === payment.amountMinor ? 'refunded' : 'partially_refunded',
          updatedAt: now,
        };
        await repo.insertRefund(refund);
        await repo.update(updated);
        return { refund: toRefundView(refund), payment: toPaymentView(updated) };
      }),
    );
  }

  /** Returns null when the outcome is unknown (timeout/network): the payment stays pending. */
  private async charge(payment: Payment): Promise<ChargeResult | null> {
    try {
      return await this.deps.provider.charge(
        { amountMinor: payment.amountMinor, currency: payment.currency, reference: payment.id },
        AbortSignal.timeout(this.deps.providerTimeoutMs),
      );
    } catch (err) {
      this.deps.logger.warn({ err, paymentId: payment.id }, 'charge outcome unknown, left pending for reconciliation');
      return null;
    }
  }
}
