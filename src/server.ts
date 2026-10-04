import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createPool } from './core/db/pool.js';
import { PgIdempotencyStore } from './core/idempotency/pg-idempotency-store.js';
import { createLogger } from './core/logger.js';
import { loadSigningKey } from './core/auth/signing-key.js';
import { migrate } from './db/migrate.js';
import { DEV_CLIENTS, InMemoryClientRegistry } from './features/auth/client-registry.js';
import { TokenService } from './features/auth/token.service.js';
import { PaymentService } from './features/payments/payment.service.js';
import { PgPaymentStore } from './features/payments/pg-payment.repository.js';
import { FakeProvider } from './integrations/provider/fake-provider.js';

async function start(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const pool = createPool(env.DATABASE_URL);

  const applied = await migrate(pool);
  if (applied.length) logger.info({ applied }, 'migrations applied');

  const paymentService = new PaymentService({
    store: new PgPaymentStore(pool),
    idempotency: new PgIdempotencyStore(pool),
    provider: new FakeProvider(),
    logger,
    providerTimeoutMs: env.PROVIDER_TIMEOUT_MS,
  });

  const signingKey = await loadSigningKey(env.JWT_PRIVATE_JWK);
  const tokenService = new TokenService(new InMemoryClientRegistry(DEV_CLIENTS), signingKey, {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    ttlSeconds: env.TOKEN_TTL_SECONDS,
  });

  const app = buildApp({
    logger,
    paymentService,
    tokenService,
    signingKey,
    checkReadiness: async () => {
      await pool.query('SELECT 1');
    },
  });

  const server = app.listen(env.PORT, () => {
    logger.info(`payments-mcp listening on http://localhost:${env.PORT} (docs at /docs)`);
  });

  // Graceful shutdown: stop accepting connections, let in-flight requests finish, then close the pool.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
