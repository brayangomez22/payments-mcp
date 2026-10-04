import { exportJWK, generateKeyPair, importJWK, type CryptoKey, type JWK } from 'jose';

export const JWT_ALGORITHM = 'ES256';

export interface SigningKey {
  /** Key id: lets verifiers pick the right public key during key rotation. */
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Public part only, safe to publish at /.well-known/jwks.json. */
  publicJwk: JWK;
}

/**
 * Loads the private key from config (a JWK JSON string, injected from a secrets manager in
 * production). Without one, generates an ephemeral key: fine for dev and tests, but every
 * restart invalidates the tokens issued before it.
 */
export async function loadSigningKey(privateJwkJson?: string): Promise<SigningKey> {
  if (privateJwkJson) {
    const jwk = JSON.parse(privateJwkJson) as JWK;
    const { d: _private, ...publicPart } = jwk;
    return {
      kid: jwk.kid ?? 'default',
      privateKey: (await importJWK(jwk, JWT_ALGORITHM)) as CryptoKey,
      publicKey: (await importJWK(publicPart, JWT_ALGORITHM)) as CryptoKey,
      publicJwk: { ...publicPart, alg: JWT_ALGORITHM, use: 'sig' },
    };
  }

  const { privateKey, publicKey } = await generateKeyPair(JWT_ALGORITHM, { extractable: true });
  const kid = `dev-${Date.now()}`;
  return {
    kid,
    privateKey,
    publicKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: JWT_ALGORITHM, use: 'sig' },
  };
}
