import { randomUUID } from 'node:crypto';
import type { ChargeRequest, ChargeResult, PaymentProvider, RefundRequest } from './payment-provider.js';

/**
 * Deterministic stand-in for a real processor:
 *   amount ending in 13 → declined, amount ending in 99 → hangs until the caller times out.
 */
export class FakeProvider implements PaymentProvider {
  readonly calls = { charge: 0, refund: 0 };

  async charge(request: ChargeRequest, signal: AbortSignal): Promise<ChargeResult> {
    this.calls.charge++;
    if (request.amountMinor % 100 === 99) await waitForAbort(signal);
    if (request.amountMinor % 100 === 13) {
      return { status: 'failed', providerRef: `fake_ch_${randomUUID()}`, failureReason: 'card_declined' };
    }
    return { status: 'succeeded', providerRef: `fake_ch_${randomUUID()}` };
  }

  async refund(_request: RefundRequest, _signal: AbortSignal): Promise<{ providerRef: string }> {
    this.calls.refund++;
    return { providerRef: `fake_re_${randomUUID()}` };
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
