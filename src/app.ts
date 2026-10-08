import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { authenticate } from './core/auth/authenticate.js';
import { errorHandler, notFoundHandler } from './core/http/error-handler.js';
import { requestContext } from './core/http/request-context.js';
import type { Logger } from './core/logger.js';
import { rememberMountPath, type Metrics } from './core/metrics.js';
import type { SigningKey } from './core/auth/signing-key.js';
import type { TokenVerifier } from './core/auth/token-verifier.js';
import { openApiDocument } from './docs/openapi.js';
import { authRoutes } from './features/auth/auth.routes.js';
import type { TokenService } from './features/auth/token.service.js';
import { paymentRoutes } from './features/payments/payment.routes.js';
import type { PaymentService } from './features/payments/payment.service.js';
import { mcpRoutes } from './mcp/mcp.routes.js';

export interface AppDeps {
  logger: Logger;
  paymentService: PaymentService;
  tokenService: TokenService;
  signingKey: SigningKey;
  /** Verifies REST tokens (aud = the REST API). */
  tokenVerifier: TokenVerifier;
  /** Verifies MCP tokens (aud = mcpResource). */
  mcpTokenVerifier: TokenVerifier;
  /** Token issuer = authorization server URL. */
  issuer: string;
  /** Resource identifier of the MCP endpoint, e.g. https://payments.example.com/mcp */
  mcpResource: string;
  /** Throws if a dependency (DB) is not reachable. */
  checkReadiness: () => Promise<void>;
  metrics: Metrics;
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(deps.logger));
  app.use(deps.metrics.httpMiddleware());
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

  // Scraped by Prometheus. In EKS keep it off the public Ingress (internal port or NetworkPolicy).
  app.get('/metrics', async (_req, res) => {
    res.type(deps.metrics.registry.contentType).send(await deps.metrics.registry.metrics());
  });

  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use(authRoutes(deps.tokenService, deps.signingKey, deps.issuer));
  app.use('/api/v1/payments', rememberMountPath, authenticate(deps.tokenVerifier), paymentRoutes(deps.paymentService));
  app.use(
    mcpRoutes({
      paymentService: deps.paymentService,
      tokenVerifier: deps.mcpTokenVerifier,
      resource: deps.mcpResource,
      authorizationServer: deps.issuer,
      metrics: deps.metrics,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
