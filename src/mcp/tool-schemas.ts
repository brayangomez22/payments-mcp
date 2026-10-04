import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import { PaymentIdSchema } from '../features/payments/payment.schemas.js';
import { CURRENCIES, PAYMENT_STATUSES } from '../features/payments/payment.types.js';

// Field descriptions end up in the JSON Schema the model reads: they ARE prompt engineering.
// Notice there is no merchantId anywhere: the merchant always comes from the access token.

export const GetPaymentInput = v.strictObject({
  paymentId: v.pipe(PaymentIdSchema, v.description('The payment id (UUID) returned when it was created.')),
});

export const ListPaymentsInput = v.strictObject({
  status: v.optional(v.pipe(v.picklist(PAYMENT_STATUSES), v.description('Only return payments in this status.'))),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100), v.description('Page size, 1-100. Defaults to 20.')),
  ),
  cursor: v.optional(
    v.pipe(v.string(), v.maxLength(200), v.description('Pass nextCursor from the previous call to get the next page.')),
  ),
});

const PaymentOutput = v.object({
  id: v.string(),
  amountMinor: v.number(),
  currency: v.picklist(CURRENCIES),
  status: v.picklist(PAYMENT_STATUSES),
  refundedMinor: v.number(),
  description: v.nullable(v.string()),
  failureReason: v.nullable(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
});

export const PaymentPageOutput = v.object({
  data: v.array(PaymentOutput),
  nextCursor: v.nullable(v.string()),
});

/** The SDK needs Standard JSON Schema: it derives the schema for tools/list and validates calls with Valibot. */
export const schemas = {
  getPaymentInput: toStandardJsonSchema(GetPaymentInput),
  listPaymentsInput: toStandardJsonSchema(ListPaymentsInput),
  paymentOutput: toStandardJsonSchema(PaymentOutput),
  paymentPageOutput: toStandardJsonSchema(PaymentPageOutput),
};
