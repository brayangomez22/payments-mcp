import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import { CreatePaymentSchema, IdempotencyKeySchema, PaymentIdSchema, RefundPaymentSchema } from '../features/payments/payment.schemas.js';
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

const IdempotencyKey = v.pipe(
  IdempotencyKeySchema,
  v.description(
    'Unique key for THIS operation (8-255 chars). Derive it from the business reference, e.g. ' +
      '"order-1001" or "order-1001-refund-1". If a call times out or fails, retry with the SAME key: ' +
      'it will never charge or refund twice. Use a NEW key only for a genuinely new operation.',
  ),
);

// Reuses the REST body schema, so both APIs accept exactly the same payments.
export const CreatePaymentInput = v.strictObject({
  ...CreatePaymentSchema.entries,
  idempotencyKey: IdempotencyKey,
});

export const RefundPaymentInput = v.strictObject({
  paymentId: GetPaymentInput.entries.paymentId,
  ...RefundPaymentSchema.entries,
  idempotencyKey: IdempotencyKey,
  confirm: v.optional(
    v.pipe(
      v.boolean(),
      v.description(
        'Omit (or false) to get a preview without moving money. Set true ONLY after showing the preview ' +
          'to the user and getting their explicit approval in this conversation.',
      ),
    ),
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

/**
 * Like toStandardJsonSchema, but transformations without a JSON Schema form (e.g. `trim`) are left
 * out of the ADVERTISED schema instead of throwing. Validation still runs the full Valibot schema.
 */
function toLenientStandardJsonSchema<S extends Parameters<typeof toStandardJsonSchema>[0]>(schema: S) {
  const standard = toStandardJsonSchema(schema);
  const { jsonSchema } = standard['~standard'];
  type Options = Parameters<typeof jsonSchema.input>[0];
  const lenient = (options: Options): Options => ({ ...options, libraryOptions: { errorMode: 'ignore', ...options.libraryOptions } });
  return {
    '~standard': {
      ...standard['~standard'],
      jsonSchema: {
        input: (options: Options) => jsonSchema.input(lenient(options)),
        output: (options: Options) => jsonSchema.output(lenient(options)),
      },
    },
  } as typeof standard;
}

/** The SDK needs Standard JSON Schema: it derives the schema for tools/list and validates calls with Valibot. */
export const schemas = {
  getPaymentInput: toStandardJsonSchema(GetPaymentInput),
  listPaymentsInput: toStandardJsonSchema(ListPaymentsInput),
  paymentOutput: toStandardJsonSchema(PaymentOutput),
  paymentPageOutput: toStandardJsonSchema(PaymentPageOutput),
  // `trim` (a transformation, not a constraint) has no JSON Schema form: it is left out of the
  // advertised schema, and Valibot still applies it when validating the call.
  createPaymentInput: toLenientStandardJsonSchema(CreatePaymentInput),
  refundPaymentInput: toStandardJsonSchema(RefundPaymentInput),
};
