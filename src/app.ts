import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { placeholderAuth } from './core/auth/placeholder-auth.js';
import { errorHandler, notFoundHandler } from './core/http/error-handler.js';
import { requestContext } from './core/http/request-context.js';
import type { Logger } from './core/logger.js';
import type { SigningKey } from './core/auth/signing-key.js';
import { openApiDocument } from './docs/openapi.js';
import { authRoutes } from './features/auth/auth.routes.js';
import type { TokenService } from './features/auth/token.service.js';
import { paymentRoutes } from './features/payments/payment.routes.js';
import type { PaymentService } from './features/payments/payment.service.js';

export interface AppDeps {
  logger: Logger;
  paymentService: PaymentService;
  tokenService: TokenService;
  signingKey: SigningKey;
  /** Throws if a dependency (DB) is not reachable. */
  checkReadiness: () => Promise<void>;
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(deps.logger));
  app.use(express.json({ limit: '100kb' }));

  // Liveness: the process is up. Readiness: it can serve traffic (k8s stops routing to it otherwise).
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (req, res) => {
    try {
      await deps.checkReadiness();
      res.json({ status: 'ok' });
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use(authRoutes(deps.tokenService, deps.signingKey));
  app.use('/api/v1/payments', placeholderAuth, paymentRoutes(deps.paymentService));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
