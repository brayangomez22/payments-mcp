import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Scope } from '../../core/auth/auth-context.js';
import { verifySecret } from '../../core/auth/secret-hash.js';
import { JWT_ALGORITHM, type SigningKey } from '../../core/auth/signing-key.js';
import type { ClientRegistry } from './client-registry.js';

/** Errors in the RFC 6749 §5.2 format, which OAuth client libraries understand. */
export class OAuthError extends Error {
  constructor(
    readonly error: 'invalid_request' | 'invalid_client' | 'unsupported_grant_type' | 'invalid_scope' | 'invalid_target',
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
  /** RFC 8707: which API the token is for. Becomes the `aud` claim. */
  resource: string | undefined;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

export interface TokenServiceConfig {
  issuer: string;
  /** Audience used when the client does not send `resource` (the REST API). */
  audience: string;
  /** Every audience this server may issue tokens for, e.g. the REST API and the MCP endpoint. */
  resources: readonly string[];
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
    const audience = this.audienceFor(request.resource);
    const now = Math.floor(Date.now() / 1000);

    const accessToken = await new SignJWT({ merchant_id: client.merchantId, scope: scopes.join(' ') })
      .setProtectedHeader({ alg: JWT_ALGORITHM, kid: this.key.kid, typ: 'at+jwt' })
      .setIssuer(this.config.issuer) // who issued it
      .setAudience(audience) // who it is for: a token for another API is rejected
      .setSubject(client.clientId) // who it represents
      .setIssuedAt(now)
      .setExpirationTime(now + this.config.ttlSeconds)
      .setJti(randomUUID()) // unique id: allows auditing or revoking a single token
      .sign(this.key.privateKey);

    return { access_token: accessToken, token_type: 'Bearer', expires_in: this.config.ttlSeconds, scope: scopes.join(' ') };
  }

  /** A token is bound to ONE resource: an MCP token is useless against the REST API and vice versa. */
  private audienceFor(resource: string | undefined): string {
    if (!resource) return this.config.audience;
    if (!this.config.resources.includes(resource)) {
      throw new OAuthError('invalid_target', 400, `Unknown resource: ${resource}`);
    }
    return resource;
  }

  /**
   * No scope requested → everything allowed. Otherwise grant the intersection (RFC 6749 §3.3 lets
   * the server narrow the request; the response's `scope` tells the client what it really got).
   * Generic clients, MCP ones included, ask for every scope the server advertises, so refusing
   * the whole request would lock them out. Only a request with nothing grantable is an error.
   */
  private grantedScopes(requested: string | undefined, allowed: readonly Scope[]): Scope[] {
    if (!requested?.trim()) return [...allowed];
    const wanted = new Set(requested.trim().split(/\s+/));
    const granted = allowed.filter((s) => wanted.has(s));
    if (!granted.length) {
      throw new OAuthError('invalid_scope', 400, `None of the requested scopes is allowed for this client: ${[...wanted].join(' ')}`);
    }
    return granted;
  }
}
