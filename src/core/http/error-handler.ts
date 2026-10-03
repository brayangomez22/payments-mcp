import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, Errors } from '../errors.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(Errors.notFound());

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const appError = toAppError(err);
  if (appError.status >= 500) {
    req.log.error({ err }, 'request failed');
  }
  if (appError.status === 401) {
    res.setHeader('WWW-Authenticate', 'Bearer');
  }
  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      requestId: req.requestId,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  });
};

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // express.json() parse failure
  if (typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed') {
    return Errors.invalidJson();
  }
  // Never leak internals (stack, SQL) to the client.
  return new AppError('INTERNAL_ERROR', 500, 'Unexpected error');
}
