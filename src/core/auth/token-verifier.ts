import { jwtVerify, type CryptoKey, type JWTVerifyGetKey } from 'jose';
import type { AuthContext, Scope } from './auth-context.js';
import { JWT_ALGORITHM } from './signing-key.js';

const KNOWN_SCOPES: ReadonlySet<string> = new Set<Scope>(['payments:read', 'payments:write', 'payments:refund']);

export interface TokenVerifier {
  /** Resolves the caller's identity or rejects (bad signature, expired, wrong audience...). */
  verify(token: string): Promise<AuthContext>;
}

export interface JwtVerifierConfig {
  /**
   * A public key (same process as the issuer) or a JWKS resolver, e.g.
   * createRemoteJWKSet(new URL('https://auth.internal/.well-known/jwks.json')) in another service.
   */
  key: CryptoKey | JWTVerifyGetKey;
  issuer: string;
  audience: string;
}

export class JwtVerifier implements TokenVerifier {
  constructor(private readonly config: JwtVerifierConfig) {}

  async verify(token: string): Promise<AuthContext> {
    // jwtVerify checks, in order: structure, allowed algorithm, signature, exp/nbf, iss, aud, typ.
    const { payload } = await jwtVerify(token, this.config.key as CryptoKey, {
      algorithms: [JWT_ALGORITHM], // never trust the token's own "alg" header (blocks alg=none / HS256 tricks)
      issuer: this.config.issuer,
      audience: this.config.audience,
      typ: 'at+jwt',
      clockTolerance: 5, // seconds of clock skew between servers
    });

    const { sub, merchant_id: merchantId, scope } = payload;
    if (typeof sub !== 'string' || typeof merchantId !== 'string' || typeof scope !== 'string') {
      throw new Error('Token is missing required claims');
    }
    return {
      clientId: sub,
      merchantId,
      scopes: new Set(scope.split(' ').filter((s): s is Scope => KNOWN_SCOPES.has(s))),
    };
  }
}
