import type { Request, RequestHandler } from 'express';
import { Errors } from '../errors.js';
import type { AuthContext } from './auth-context.js';

/**
 * TEMPORARY (phase 1): trusts an X-Merchant-Id header and grants every scope.
 * Replaced in phase 2 by JWT verification. Never ship this.
 */
export const placeholderAuth: RequestHandler = (req, _res, next) => {
  const merchantId = req.get('x-merchant-id');
  if (!merchantId) return next(Errors.unauthenticated());
  req.auth = {
    clientId: 'placeholder',
    merchantId,
    scopes: new Set(['payments:read', 'payments:write', 'payments:refund']),
  };
  next();
};

export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw Errors.unauthenticated();
  return req.auth;
}
