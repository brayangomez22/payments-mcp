export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'partially_refunded', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const CURRENCIES = ['COP', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const REFUNDABLE_STATUSES: ReadonlySet<PaymentStatus> = new Set(['succeeded', 'partially_refunded']);

/** Domain entity. Money is always an integer amount of minor units (cents, or pesos for COP). */
export interface Payment {
  id: string;
  merchantId: string;
  amountMinor: number;
  currency: Currency;
  status: PaymentStatus;
  refundedMinor: number;
  description: string | null;
  providerRef: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Refund {
  id: string;
  paymentId: string;
  amountMinor: number;
  providerRef: string;
  createdAt: Date;
}

export interface Cursor {
  createdAt: Date;
  id: string;
}

export interface ListFilter {
  status?: PaymentStatus | undefined;
  limit: number;
  after?: Cursor | undefined;
}

/** JSON-safe representation returned by REST, MCP and stored for idempotent replays. */
export interface PaymentView {
  id: string;
  amountMinor: number;
  currency: Currency;
  status: PaymentStatus;
  refundedMinor: number;
  description: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RefundView {
  id: string;
  paymentId: string;
  amountMinor: number;
  createdAt: string;
}

export interface PaymentPage {
  data: PaymentView[];
  nextCursor: string | null;
}

export function toPaymentView(p: Payment): PaymentView {
  return {
    id: p.id,
    amountMinor: p.amountMinor,
    currency: p.currency,
    status: p.status,
    refundedMinor: p.refundedMinor,
    description: p.description,
    failureReason: p.failureReason,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toRefundView(r: Refund): RefundView {
  return { id: r.id, paymentId: r.paymentId, amountMinor: r.amountMinor, createdAt: r.createdAt.toISOString() };
}
