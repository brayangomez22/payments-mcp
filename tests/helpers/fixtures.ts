import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../src/app.js';
import { loadSigningKey } from '../../src/core/auth/signing-key.js';
import { JwtVerifier } from '../../src/core/auth/token-verifier.js';
import { DEV_CLIENTS, InMemoryClientRegistry } from '../../src/features/auth/client-registry.js';
import { TokenService } from '../../src/features/auth/token.service.js';
import { createLogger } from '../../src/core/logger.js';
import { Metrics } from '../../src/core/metrics.js';
import { PaymentService } from '../../src/features/payments/payment.service.js';
import { FakeProvider } from '../../src/integrations/provider/fake-provider.js';
import { InMemoryIdempotencyStore, InMemoryPaymentStore } from './in-memory.js';

export const silentLogger = createLogger('silent');

export function createService(overrides: { providerTimeoutMs?: number; clock?: () => Date; metrics?: Metrics } = {}) {
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
    ...(overrides.metrics ? { metrics: overrides.metrics } : {}),
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

export const REST_AUDIENCE = 'payments-api';

export async function startTestServer(options: { ready?: () => Promise<void> } = {}) {
  // Listen first: the issuer and the MCP resource are URLs that include the random port.
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const issuer = baseUrl;
  const mcpResource = `${baseUrl}/mcp`;

  const metrics = new Metrics({ defaultMetrics: false });
  const ctx = createService({ clock: tickingClock(), metrics });
  const signingKey = await loadSigningKey();
  const tokenService = new TokenService(new InMemoryClientRegistry(DEV_CLIENTS), signingKey, {
    issuer,
    audience: REST_AUDIENCE,
    resources: [REST_AUDIENCE, mcpResource],
    ttlSeconds: 900,
  });
  const verifierFor = (audience: string) => new JwtVerifier({ key: signingKey.publicKey, issuer, audience });
  server.on(
    'request',
    buildApp({
      logger: silentLogger,
      paymentService: ctx.service,
      tokenService,
      signingKey,
      tokenVerifier: verifierFor(REST_AUDIENCE),
      mcpTokenVerifier: verifierFor(mcpResource),
      issuer,
      mcpResource,
      metrics,
      checkReadiness: options.ready ?? (async () => undefined),
    }),
  );

  return {
    ...ctx,
    metrics,
    signingKey,
    issuer,
    mcpResource,
    /** Issues a real token through the token service (as POST /oauth/token would). Default audience: REST. */
    tokenFor: async (clientId: keyof typeof DEV_SECRETS, options: { scope?: string; resource?: string } = {}) =>
      (
        await tokenService.issue({
          grantType: 'client_credentials',
          clientId,
          clientSecret: DEV_SECRETS[clientId],
          scope: options.scope,
          resource: options.resource,
        })
      ).access_token,
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
