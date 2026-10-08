import { randomUUID } from 'node:crypto';
import type { OutboxMessage } from '../../core/events/outbox.js';
import type { Payment } from './payment.types.js';

/** Body of every payment.<status> message (Requirement 6.1). */
export interface PaymentEventPayload {
  [key: string]: unknown;
  /** Unique per event: delivery is at-least-once, so consumers dedupe on it. */
  eventId: string;
  type: `payment.${Payment['status']}`;
  paymentId: string;
  merchantId: string;
  status: Payment['status'];
  requestId: string | null;
  occurredAt: string;
}

/** The event for the state `payment` is in right now. Written in the same transaction as that state. */
export function paymentStatusEvent(payment: Payment, requestId: string | undefined): OutboxMessage {
  const type = `payment.${payment.status}` as const;
  const payload: PaymentEventPayload = {
    eventId: randomUUID(),
    type,
    paymentId: payment.id,
    merchantId: payment.merchantId,
    status: payment.status,
    requestId: requestId ?? null,
    occurredAt: payment.updatedAt.toISOString(),
  };
  return { topic: type, payload };
}
