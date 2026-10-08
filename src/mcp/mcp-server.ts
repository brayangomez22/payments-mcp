import { McpServer } from '@modelcontextprotocol/server';
import type { AuthContext, Scope } from '../core/auth/auth-context.js';
import type { Logger } from '../core/logger.js';
import type { MerchantContext, PaymentService } from '../features/payments/payment.service.js';
import type { Metrics } from '../core/metrics.js';
import { runTool, toolSuccess, type ToolContext } from './tool-result.js';
import { schemas } from './tool-schemas.js';

export interface McpServerDeps {
  paymentService: PaymentService;
  /** Verified caller, built per request: every tool runs as THIS merchant. */
  auth: AuthContext;
  logger: Logger;
  /** The HTTP request's id: events emitted by a tool call carry it. */
  requestId?: string;
  metrics?: Metrics | undefined;
}

const AMOUNT_NOTE =
  'Amounts are integers in minor units: USD in cents (1050 = $10.50), COP in whole pesos (150000 = $150.000).';

/**
 * A new server per request (stateless mode). Tools close over `auth`, so the model can never
 * choose which merchant it acts for: there is no merchant argument to manipulate.
 */
export function buildMcpServer({ paymentService, auth, logger, requestId, metrics }: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: 'payments-mcp', version: '0.1.0' },
    {
      instructions:
        'Payments API for a single merchant (the one in your access token). ' +
        'Use get_payment when you know the payment id; use list_payments to search recent payments. ' +
        'Tools that move money take an idempotencyKey: on any error or timeout, retry with the SAME key. ' +
        AMOUNT_NOTE,
    },
  );
  const merchant: MerchantContext = { merchantId: auth.merchantId, requestId };
  const log = logger.child({ mcpClient: auth.clientId });
  // A tool is only registered when the token carries its scope: tools/list shows exactly what this
  // caller may do. What the model cannot see, it cannot be tricked into calling.
  const can = (scope: Scope): boolean => auth.scopes.has(scope);

  const deps: ToolDeps = { paymentService, merchant, tool: { log, metrics } };
  if (can('payments:read')) registerReadTools(server, deps);
  if (can('payments:write')) registerCreatePayment(server, deps);
  if (can('payments:refund')) registerRefundPayment(server, deps);

  return server;
}

interface ToolDeps {
  paymentService: PaymentService;
  merchant: MerchantContext;
  tool: ToolContext;
}

function registerReadTools(server: McpServer, { paymentService, merchant, tool }: ToolDeps): void {
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
    ({ paymentId }) => runTool(tool, 'get_payment', async () => toolSuccess(await paymentService.get(merchant, paymentId))),
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
      runTool(tool, 'list_payments', async () =>
        toolSuccess(await paymentService.list(merchant, { limit: limit ?? 20, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) })),
      ),
  );
}

function registerCreatePayment(server: McpServer, { paymentService, merchant, tool }: ToolDeps): void {
  server.registerTool(
    'create_payment',
    {
      title: 'Charge a payment',
      description:
        'Charge the customer. Returns the payment with its status: "succeeded" (charged), "failed" (declined, ' +
        'see failureReason; do not retry the same card) or "pending" (the processor did not answer in time: ' +
        'the outcome is unknown, so do NOT charge again with a new key; check later with get_payment). ' +
        AMOUNT_NOTE,
      inputSchema: schemas.createPaymentInput,
      outputSchema: schemas.paymentOutput,
      // Not destructive (it adds a payment), idempotent with the same key, talks to an external processor.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ idempotencyKey, ...input }) =>
      runTool(tool, 'create_payment', async () => toolSuccess(await paymentService.create(merchant, input, idempotencyKey))),
  );
}

function registerRefundPayment(server: McpServer, { paymentService, merchant, tool }: ToolDeps): void {
  server.registerTool(
    'refund_payment',
    {
      title: 'Refund a payment',
      description:
        'Return money to the customer, fully or partially. Two steps: call WITHOUT confirm to get a preview ' +
        '(nothing happens); show it to the user; only after they explicitly approve, call again with the same ' +
        'arguments plus confirm: true. Refunds cannot be undone. ' +
        AMOUNT_NOTE,
      inputSchema: schemas.refundPaymentInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ paymentId, amountMinor, idempotencyKey, confirm }) =>
      runTool(tool, 'refund_payment', async () => {
        if (confirm !== true) {
          // Same validations as the real refund, zero side effects, idempotency key untouched.
          const preview = await paymentService.previewRefund(merchant, paymentId, { amountMinor });
          return toolSuccess({
            preview: true,
            ...preview,
            nextStep:
              'Nothing was refunded. Ask the user to approve this exact refund; if they do, call refund_payment ' +
              'again with the same arguments and confirm: true.',
          });
        }
        return toolSuccess(await paymentService.refund(merchant, paymentId, { amountMinor }, idempotencyKey));
      }),
  );
}
