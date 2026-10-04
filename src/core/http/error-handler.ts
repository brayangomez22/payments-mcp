import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, Errors } from '../errors.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(Errors.notFound());

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const appError = toAppError(err);
  if (appError.status >= 500) {
    req.log.error({ err }, 'request failed');
  }
  const challenge = wwwAuthenticate(appError);
  if (challenge) res.setHeader('WWW-Authenticate', challenge);
  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      requestId: req.requestId,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  });
};

/** RFC 6750 §3: tells the client WHY auth failed, so it knows whether to refresh the token or give up. */
function wwwAuthenticate(error: AppError): string | null {
  const metadata = error.resourceMetadataUrl ? `, resource_metadata="${error.resourceMetadataUrl}"` : '';
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return `Bearer realm="payments-mcp"${metadata}`;
    case 'INVALID_TOKEN':
      return `Bearer realm="payments-mcp", error="invalid_token"${metadata}`;
    case 'INSUFFICIENT_SCOPE': {
      const { requiredScope } = error.details as { requiredScope: string };
      return `Bearer realm="payments-mcp", error="insufficient_scope", scope="${requiredScope}"`;
    }
    default:
      return null;
  }
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // express.json() parse failure
  if (typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed') {
    return Errors.invalidJson();
  }
  // Never leak internals (stack, SQL) to the client.
  return new AppError('INTERNAL_ERROR', 500, 'Unexpected error');
}
