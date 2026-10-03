const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const errorResponse = (description: string) => ({ description, content: json(ref('Error')) });

const idempotencyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description: 'Unique per logical operation. Retries with the same key and body return the original result.',
  schema: { type: 'string', minLength: 8, maxLength: 255 },
};
const paymentIdParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'payments-mcp',
    version: '0.1.0',
    description: 'Payments middleware. The same operations are exposed to AI agents over MCP at /mcp.',
  },
  servers: [{ url: '/api/v1' }],
  security: [{ merchantHeader: [] }],
  paths: {
    '/payments': {
      post: {
        summary: 'Create a payment',
        operationId: 'createPayment',
        parameters: [idempotencyHeader],
        requestBody: { required: true, content: json(ref('CreatePayment')) },
        responses: {
          201: { description: 'Created; status is succeeded or failed', content: json(ref('Payment')) },
          202: { description: 'Accepted; provider outcome unknown, status is pending', content: json(ref('Payment')) },
          400: errorResponse('Validation error or missing Idempotency-Key'),
          401: errorResponse('Unauthenticated'),
          409: errorResponse('Same Idempotency-Key still in progress'),
          422: errorResponse('Idempotency-Key reused with a different body'),
        },
      },
      get: {
        summary: 'List payments (newest first, cursor pagination)',
        operationId: 'listPayments',
        parameters: [
          { name: 'status', in: 'query', schema: ref('PaymentStatus') },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'nextCursor from the previous page' },
        ],
        responses: {
          200: {
            description: 'A page of payments',
            content: json({
              type: 'object',
              required: ['data', 'nextCursor'],
              properties: { data: { type: 'array', items: ref('Payment') }, nextCursor: { type: ['string', 'null'] } },
            }),
          },
          400: errorResponse('Invalid query or cursor'),
        },
      },
    },
    '/payments/{id}': {
      get: {
        summary: 'Get a payment',
        operationId: 'getPayment',
        parameters: [paymentIdParam],
        responses: { 200: { description: 'The payment', content: json(ref('Payment')) }, 404: errorResponse('Not found') },
      },
    },
    '/payments/{id}/refunds': {
      post: {
        summary: 'Refund a payment (full or partial)',
        operationId: 'refundPayment',
        parameters: [paymentIdParam, idempotencyHeader],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['amountMinor'],
            additionalProperties: false,
            properties: { amountMinor: { type: 'integer', minimum: 1 } },
          }),
        },
        responses: {
          201: {
            description: 'Refunded',
            content: json({
              type: 'object',
              properties: { refund: ref('Refund'), payment: ref('Payment') },
            }),
          },
          404: errorResponse('Not found'),
          409: errorResponse('Not refundable or exceeds the remaining amount'),
          502: errorResponse('Provider did not complete the refund'),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      merchantHeader: { type: 'apiKey', in: 'header', name: 'X-Merchant-Id', description: 'Phase 1 only; replaced by OAuth2' },
    },
    schemas: {
      PaymentStatus: { type: 'string', enum: ['pending', 'succeeded', 'failed', 'partially_refunded', 'refunded'] },
      CreatePayment: {
        type: 'object',
        required: ['amountMinor', 'currency'],
        additionalProperties: false,
        properties: {
          amountMinor: { type: 'integer', minimum: 1, description: 'Amount in minor units', examples: [150000] },
          currency: { type: 'string', enum: ['COP', 'USD'] },
          description: { type: 'string', maxLength: 255 },
        },
      },
      Payment: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          amountMinor: { type: 'integer' },
          currency: { type: 'string' },
          status: ref('PaymentStatus'),
          refundedMinor: { type: 'integer' },
          description: { type: ['string', 'null'] },
          failureReason: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Refund: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          paymentId: { type: 'string', format: 'uuid' },
          amountMinor: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              requestId: { type: 'string' },
              details: {},
            },
          },
        },
      },
    },
  },
};
