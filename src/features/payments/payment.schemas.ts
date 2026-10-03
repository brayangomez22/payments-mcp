import * as v from 'valibot';
import { CURRENCIES, PAYMENT_STATUSES } from './payment.types.js';

// 10^12 minor units: far above any real charge, far below Number.MAX_SAFE_INTEGER.
const MAX_AMOUNT_MINOR = 1_000_000_000_000;

const AmountMinor = v.pipe(
  v.number(),
  v.integer('amountMinor must be an integer in minor units'),
  v.minValue(1),
  v.maxValue(MAX_AMOUNT_MINOR),
);

// strictObject: unknown keys (e.g. a smuggled "merchantId") are rejected, not ignored.
export const CreatePaymentSchema = v.strictObject({
  amountMinor: AmountMinor,
  currency: v.picklist(CURRENCIES),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(255))),
});
export type CreatePaymentInput = v.InferOutput<typeof CreatePaymentSchema>;

export const RefundPaymentSchema = v.strictObject({
  amountMinor: AmountMinor,
});
export type RefundPaymentInput = v.InferOutput<typeof RefundPaymentSchema>;

export const ListPaymentsSchema = v.object({
  status: v.optional(v.picklist(PAYMENT_STATUSES)),
  limit: v.optional(
    v.pipe(v.union([v.string(), v.number()]), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(100)),
    20,
  ),
  cursor: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
export type ListPaymentsInput = v.InferOutput<typeof ListPaymentsSchema>;

export const PaymentIdSchema = v.pipe(v.string(), v.uuid('id must be a UUID'));

export const IdempotencyKeySchema = v.pipe(v.string(), v.minLength(8), v.maxLength(255));
