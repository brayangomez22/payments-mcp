export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (details: unknown) => new AppError('VALIDATION_ERROR', 400, 'Request is invalid', details),
  invalidJson: () => new AppError('INVALID_JSON', 400, 'Request body is not valid JSON'),
  invalidCursor: () => new AppError('INVALID_CURSOR', 400, 'Cursor is malformed'),
  idempotencyKeyRequired: () =>
    new AppError('IDEMPOTENCY_KEY_REQUIRED', 400, 'Idempotency-Key header is required'),
  idempotencyKeyReused: () =>
    new AppError('IDEMPOTENCY_KEY_REUSED', 422, 'Idempotency-Key was already used with a different request'),
  requestInProgress: () =>
    new AppError('REQUEST_IN_PROGRESS', 409, 'A request with this Idempotency-Key is still being processed'),
  unauthenticated: () => new AppError('UNAUTHENTICATED', 401, 'A Bearer token is required'),
  invalidToken: () => new AppError('INVALID_TOKEN', 401, 'The access token is invalid or expired'),
  forbidden: (scope: string) =>
    new AppError('INSUFFICIENT_SCOPE', 403, `Missing required scope: ${scope}`, { requiredScope: scope }),
  notFound: () => new AppError('NOT_FOUND', 404, 'Route not found'),
  paymentNotFound: () => new AppError('PAYMENT_NOT_FOUND', 404, 'Payment not found'),
  paymentNotRefundable: (status: string) =>
    new AppError('PAYMENT_NOT_REFUNDABLE', 409, `Payment in status "${status}" cannot be refunded`),
  refundExceedsAmount: (remainingMinor: number) =>
    new AppError('REFUND_EXCEEDS_AMOUNT', 409, `Refund exceeds the refundable amount (${remainingMinor})`, {
      remainingMinor,
    }),
  providerUnavailable: () =>
    new AppError('PROVIDER_UNAVAILABLE', 502, 'Payment provider did not complete the operation'),
};
