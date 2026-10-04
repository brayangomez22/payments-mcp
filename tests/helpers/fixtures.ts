import type { AddressInfo } from 'node:net';
import { buildApp } from '../../src/app.js';
import { loadSigningKey } from '../../src/core/auth/signing-key.js';
import { JwtVerifier } from '../../src/core/auth/token-verifier.js';
import { DEV_CLIENTS, InMemoryClientRegistry } from '../../src/features/auth/client-registry.js';
import { TokenService } from '../../src/features/auth/token.service.js';
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

export const DEV_SECRETS = {
  'tienda-a-backend': 'dev-secret-tienda-a',
  'tienda-a-agent': 'dev-secret-agent-a',
  'tienda-b-backend': 'dev-secret-tienda-b',
} as const;

export const TOKEN_CONFIG = { issuer: 'payments-mcp', audience: 'payments-api', ttlSeconds: 900 };

export async function startTestServer(options: { ready?: () => Promise<void> } = {}) {
  const ctx = createService({ clock: tickingClock() });
  const signingKey = await loadSigningKey();
  const tokenService = new TokenService(new InMemoryClientRegistry(DEV_CLIENTS), signingKey, TOKEN_CONFIG);
  const app = buildApp({
    logger: silentLogger,
    paymentService: ctx.service,
    tokenService,
    signingKey,
    tokenVerifier: new JwtVerifier({ key: signingKey.publicKey, issuer: TOKEN_CONFIG.issuer, audience: TOKEN_CONFIG.audience }),
    checkReadiness: options.ready ?? (async () => undefined),
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...ctx,
    signingKey,
    /** Issues a real token through the token service (as POST /oauth/token would). */
    tokenFor: async (clientId: keyof typeof DEV_SECRETS, scope?: string) =>
      (await tokenService.issue({ grantType: 'client_credentials', clientId, clientSecret: DEV_SECRETS[clientId], scope }))
        .access_token,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
