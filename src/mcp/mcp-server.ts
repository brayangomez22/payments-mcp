import { McpServer } from '@modelcontextprotocol/server';
import type { AuthContext, Scope } from '../core/auth/auth-context.js';
import type { Logger } from '../core/logger.js';
import type { PaymentService } from '../features/payments/payment.service.js';
import { runTool, toolSuccess } from './tool-result.js';
import { schemas } from './tool-schemas.js';

export interface McpServerDeps {
  paymentService: PaymentService;
  /** Verified caller, built per request: every tool runs as THIS merchant. */
  auth: AuthContext;
  logger: Logger;
}

const AMOUNT_NOTE =
  'Amounts are integers in minor units: USD in cents (1050 = $10.50), COP in whole pesos (150000 = $150.000).';

/**
 * A new server per request (stateless mode). Tools close over `auth`, so the model can never
 * choose which merchant it acts for: there is no merchant argument to manipulate.
 */
export function buildMcpServer({ paymentService, auth, logger }: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: 'payments-mcp', version: '0.1.0' },
    {
      instructions:
        'Payments API for a single merchant (the one in your access token). ' +
        'Use get_payment when you know the payment id; use list_payments to search recent payments. ' +
        AMOUNT_NOTE,
    },
  );
  const merchant = { merchantId: auth.merchantId };
  const log = logger.child({ mcpClient: auth.clientId });
  // A tool is only registered when the token carries its scope: tools/list shows exactly what this
  // caller may do. What the model cannot see, it cannot be tricked into calling.
  const can = (scope: Scope): boolean => auth.scopes.has(scope);

  if (can('payments:read')) registerReadTools(server, { paymentService, merchant, log });

  return server;
}

interface ToolDeps {
  paymentService: PaymentService;
  merchant: { merchantId: string };
  log: Logger;
}

function registerReadTools(server: McpServer, { paymentService, merchant, log }: ToolDeps): void {
  server.registerTool(
    'get_payment',
    {
      title: 'Get payment',
      description:
        'Get one payment by id: amount, currency, status (pending, succeeded, failed, partially_refunded, ' +
        'refunded), how much has been refunded and why it failed, if it did. ' +
        AMOUNT_NOTE,
      inputSchema: schemas.getPaymentInput,
      outputSchema: schemas.paymentOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ paymentId }) => runTool(log, 'get_payment', async () => toolSuccess(await paymentService.get(merchant, paymentId))),
  );

  server.registerTool(
    'list_payments',
    {
      title: 'List payments',
      description:
        'List payments newest first, optionally filtered by status. Returns at most `limit` items and a ' +
        'nextCursor; call again with that cursor to get older payments. nextCursor is null on the last page.',
      inputSchema: schemas.listPaymentsInput,
      outputSchema: schemas.paymentPageOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ status, limit, cursor }) =>
      runTool(log, 'list_payments', async () =>
        toolSuccess(await paymentService.list(merchant, { limit: limit ?? 20, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) })),
      ),
  );
}
