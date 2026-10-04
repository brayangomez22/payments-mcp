import express, { Router, type Request } from 'express';
import type { Scope } from '../../core/auth/auth-context.js';
import type { SigningKey } from '../../core/auth/signing-key.js';
import { OAuthError, type TokenRequest, type TokenService } from './token.service.js';

export const SUPPORTED_SCOPES: readonly Scope[] = ['payments:read', 'payments:write', 'payments:refund'];

export function authRoutes(tokens: TokenService, key: SigningKey, issuer: string): Router {
  const router = Router();

  // RFC 8414: lets clients discover the token endpoint instead of hard-coding it.
  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      issuer,
      // Optional per RFC 8414 when only client_credentials is supported, but some clients (the MCP
      // SDK among them) require it. It exists and answers with the standard "not supported" error.
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: SUPPORTED_SCOPES,
      response_types_supported: [],
    });
  });

  // Interactive (browser) flows are not offered: machine clients only.
  router.get('/oauth/authorize', (_req, res) => {
    res.status(400).json({
      error: 'unsupported_response_type',
      error_description: 'Only the client_credentials grant is supported',
    });
  });

  // RFC 6749 requires form encoding for the token endpoint.
  router.post('/oauth/token', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
    // Tokens must never be cached by proxies or browsers.
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await tokens.issue(readTokenRequest(req)));
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      if (err.status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="payments-mcp"');
      res.status(err.status).json({ error: err.error, error_description: err.description });
    }
  });

  // Public keys for verifiers (other services, the MCP gateway...). Safe to expose.
  router.get('/.well-known/jwks.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ keys: [key.publicJwk] });
  });

  return router;
}

/** Credentials may come as HTTP Basic (client_secret_basic) or in the body (client_secret_post). */
function readTokenRequest(req: Request): TokenRequest {
  const body = (req.body ?? {}) as Record<string, string | undefined>;
  const basic = parseBasicAuth(req.get('authorization'));
  return {
    grantType: body['grant_type'],
    clientId: basic?.clientId ?? body['client_id'],
    clientSecret: basic?.clientSecret ?? body['client_secret'],
    scope: body['scope'],
    resource: body['resource'],
  };
}

function parseBasicAuth(header: string | undefined): { clientId: string; clientSecret: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator)),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
  };
}
