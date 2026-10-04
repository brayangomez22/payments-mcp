import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Scope } from '../../core/auth/auth-context.js';
import { verifySecret } from '../../core/auth/secret-hash.js';
import { JWT_ALGORITHM, type SigningKey } from '../../core/auth/signing-key.js';
import type { ClientRegistry } from './client-registry.js';

/** Errors in the RFC 6749 §5.2 format, which OAuth client libraries understand. */
export class OAuthError extends Error {
  constructor(
    readonly error: 'invalid_request' | 'invalid_client' | 'unsupported_grant_type' | 'invalid_scope',
    readonly status: number,
    readonly description: string,
  ) {
    super(description);
  }
}

export interface TokenRequest {
  grantType: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** Optional, space-separated. Lets a client ask for LESS than it is allowed. */
  scope: string | undefined;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

export interface TokenServiceConfig {
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

// Precomputed hash of a random value: an unknown client_id still pays the scrypt cost.
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export class TokenService {
  constructor(
    private readonly clients: ClientRegistry,
    private readonly key: SigningKey,
    private readonly config: TokenServiceConfig,
  ) {}

  async issue(request: TokenRequest): Promise<TokenResponse> {
    if (request.grantType !== 'client_credentials') {
      throw new OAuthError('unsupported_grant_type', 400, 'Only client_credentials is supported');
    }
    if (!request.clientId || !request.clientSecret) {
      throw new OAuthError('invalid_request', 400, 'client_id and client_secret are required');
    }

    // Same response and similar timing for "unknown client" and "wrong secret": an attacker
    // cannot use this endpoint to discover which client ids exist.
    const client = await this.clients.find(request.clientId);
    const secretOk = await verifySecret(request.clientSecret, client?.secretHash ?? DUMMY_HASH);
    if (!client || !secretOk) {
      throw new OAuthError('invalid_client', 401, 'Client authentication failed');
    }

    const scopes = this.grantedScopes(request.scope, client.allowedScopes);
    const now = Math.floor(Date.now() / 1000);

    const accessToken = await new SignJWT({ merchant_id: client.merchantId, scope: scopes.join(' ') })
      .setProtectedHeader({ alg: JWT_ALGORITHM, kid: this.key.kid, typ: 'at+jwt' })
      .setIssuer(this.config.issuer) // who issued it
      .setAudience(this.config.audience) // who it is for: a token for another API is rejected
      .setSubject(client.clientId) // who it represents
      .setIssuedAt(now)
      .setExpirationTime(now + this.config.ttlSeconds)
      .setJti(randomUUID()) // unique id: allows auditing or revoking a single token
      .sign(this.key.privateKey);

    return { access_token: accessToken, token_type: 'Bearer', expires_in: this.config.ttlSeconds, scope: scopes.join(' ') };
  }

  /** No scope requested → everything allowed. Asking for a scope you don't have is an error. */
  private grantedScopes(requested: string | undefined, allowed: readonly Scope[]): Scope[] {
    if (!requested?.trim()) return [...allowed];
    const wanted = [...new Set(requested.trim().split(/\s+/))];
    const notAllowed = wanted.filter((s) => !allowed.includes(s as Scope));
    if (notAllowed.length) {
      throw new OAuthError('invalid_scope', 400, `Scope not allowed for this client: ${notAllowed.join(' ')}`);
    }
    return wanted as Scope[];
  }
}
