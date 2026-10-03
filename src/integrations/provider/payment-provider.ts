import type { Currency } from '../../features/payments/payment.types.js';

export interface ChargeRequest {
  amountMinor: number;
  currency: Currency;
  /** Our payment id, sent so the provider can deduplicate retries on its side too. */
  reference: string;
}

export type ChargeResult =
  | { status: 'succeeded'; providerRef: string }
  | { status: 'failed'; providerRef: string | null; failureReason: string };

export interface RefundRequest {
  providerRef: string;
  amountMinor: number;
  reference: string;
}

/**
 * Port for the external processor. A rejected promise means "outcome unknown"
 * (timeout, network error); a declined card is a resolved `failed` result.
 */
export interface PaymentProvider {
  charge(request: ChargeRequest, signal: AbortSignal): Promise<ChargeResult>;
  refund(request: RefundRequest, signal: AbortSignal): Promise<{ providerRef: string }>;
}
