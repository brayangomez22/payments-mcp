import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Router } from 'express';
import { authenticate, getAuth } from '../core/auth/authenticate.js';
import type { TokenVerifier } from '../core/auth/token-verifier.js';
import { SUPPORTED_SCOPES } from '../features/auth/auth.routes.js';
import type { PaymentService } from '../features/payments/payment.service.js';
import { buildMcpServer } from './mcp-server.js';

export interface McpRoutesDeps {
  paymentService: PaymentService;
  /** Verifies tokens whose audience is THIS endpoint (`resource`), not the REST API. */
  tokenVerifier: TokenVerifier;
  /** The MCP resource identifier, e.g. https://payments.example.com/mcp */
  resource: string;
  /** Who issues tokens for it. */
  authorizationServer: string;
}

export function mcpRoutes({ paymentService, tokenVerifier, resource, authorizationServer }: McpRoutesDeps): Router {
  const router = Router();
  const metadataPath = `/.well-known/oauth-protected-resource${new URL(resource).pathname}`;
  const resourceMetadataUrl = new URL(metadataPath, resource).href;

  // RFC 9728 Protected Resource Metadata: "this is what I am and who issues my tokens".
  // Served at the path-specific location and at the root, which clients fall back to.
  router.get([metadataPath, '/.well-known/oauth-protected-resource'], (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      resource,
      authorization_servers: [authorizationServer],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'payments-mcp',
    });
  });

  // No valid token → 401 whose WWW-Authenticate points at the metadata above.
  router.post('/mcp', authenticate(tokenVerifier, { resourceMetadataUrl }), async (req, res) => {
    const server = buildMcpServer({ paymentService, auth: getAuth(req), logger: req.log });
    // Stateless: no Mcp-Session-Id, so any pod can serve any request (no sticky sessions in EKS).
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // express.json() already consumed the stream: hand over the parsed body.
    await transport.handleRequest(req, res, req.body);
  });

  // GET (server→client stream) and DELETE (end session) only make sense with sessions.
  router.all('/mcp', (_req, res) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless' }, id: null });
  });

  return router;
}
