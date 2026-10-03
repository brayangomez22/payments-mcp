import type { AddressInfo } from 'node:net';
import { buildApp } from '../../src/app.js';
import { createLogger } from '../../src/core/logger.js';
import { PaymentService } from '../../src/features/payments/payment.service.js';
import { FakeProvider } from '../../src/integrations/provider/fake-provider.js';
import { InMemoryIdempotencyStore, InMemoryPaymentStore } from './in-memory.js';

export const silentLogger = createLogger('silent');

export function createService(overrides: { providerTimeoutMs?: number; clock?: () => Date } = {}) {
  const store = new InMemoryPaymentStore();
  const idempotency = new InMemoryIdempotencyStore();
  const provider = new FakeProvider();
  const service = new PaymentService({
    store,
    idempotency,
    provider,
    logger: silentLogger,
    providerTimeoutMs: overrides.providerTimeoutMs ?? 50,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });
  return { service, store, idempotency, provider };
}

/** Clock that advances 1 ms per call, so ordering by createdAt is deterministic. */
export function tickingClock(start = Date.parse('2026-10-01T00:00:00.000Z')): () => Date {
  let t = start;
  return () => new Date(t++);
}

export async function startTestServer(options: { ready?: () => Promise<void> } = {}) {
  const ctx = createService({ clock: tickingClock() });
  const app = buildApp({
    logger: silentLogger,
    paymentService: ctx.service,
    checkReadiness: options.ready ?? (async () => undefined),
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...ctx,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
