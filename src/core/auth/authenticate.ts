import type { Request, RequestHandler } from 'express';
import { Errors } from '../errors.js';
import type { AuthContext, Scope } from './auth-context.js';
import type { TokenVerifier } from './token-verifier.js';

/** 401 if there is no valid Bearer token. On success, req.caller holds the caller's identity. */
export function authenticate(verifier: TokenVerifier): RequestHandler {
  return async (req, _res, next) => {
    const match = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(req.get('authorization') ?? '');
    if (!match?.[1]) return next(Errors.unauthenticated());

    try {
      req.caller = await verifier.verify(match[1]);
    } catch (err) {
      // The exact reason goes to the logs, not to the caller.
      req.log.info({ reason: err instanceof Error ? err.message : String(err) }, 'token rejected');
      return next(Errors.invalidToken());
    }
    req.log = req.log.child({ clientId: req.caller.clientId, merchantId: req.caller.merchantId });
    next();
  };
}

/** 403 if the authenticated caller lacks `scope`. Must run after authenticate(). */
export function requireScope(scope: Scope): RequestHandler {
  return (req, _res, next) => {
    const auth = getAuth(req);
    if (!auth.scopes.has(scope)) return next(Errors.forbidden(scope));
    next();
  };
}

export function getAuth(req: Request): AuthContext {
  if (!req.caller) throw Errors.unauthenticated();
  return req.caller;
}
