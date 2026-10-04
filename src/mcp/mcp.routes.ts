import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Router } from 'express';
import { authenticate, getAuth } from '../core/auth/authenticate.js';
import type { TokenVerifier } from '../core/auth/token-verifier.js';
import type { PaymentService } from '../features/payments/payment.service.js';
import { buildMcpServer } from './mcp-server.js';

export interface McpRoutesDeps {
  paymentService: PaymentService;
  tokenVerifier: TokenVerifier;
}

export function mcpRoutes({ paymentService, tokenVerifier }: McpRoutesDeps): Router {
  const router = Router();

  // Same JWT check as REST: no valid token → 401 before any MCP message is even parsed.
  router.post('/mcp', authenticate(tokenVerifier), async (req, res) => {
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
