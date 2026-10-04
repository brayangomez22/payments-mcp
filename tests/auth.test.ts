import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { hashSecret, verifySecret } from '../src/core/auth/secret-hash.js';
import { loadSigningKey } from '../src/core/auth/signing-key.js';
import { JwtVerifier } from '../src/core/auth/token-verifier.js';
import { exportJWK } from 'jose';
import { startTestServer, TOKEN_CONFIG } from './helpers/fixtures.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;

describe('POST /oauth/token', () => {
  let server: Server;
  before(async () => {
    server = await startTestServer();
  });
  after(() => server.close());

  const requestToken = (form: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${server.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(form).toString(),
    });

  it('issues a Bearer token with all allowed scopes by default (4.1)', async () => {
    const res = await requestToken({
      grant_type: 'client_credentials',
      client_id: 'tienda-a-backend',
      client_secret: 'dev-secret-tienda-a',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.expires_in, 900);
    assert.equal(body.scope, 'payments:read payments:write payments:refund');
  });

  it('accepts HTTP Basic client authentication and a narrower scope', async () => {
    const basic = Buffer.from('tienda-b-backend:dev-secret-tienda-b').toString('base64');
    const res = await requestToken({ grant_type: 'client_credentials', scope: 'payments:read' }, { authorization: `Basic ${basic}` });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).scope, 'payments:read');
  });

  it('answers the same for an unknown client and a wrong secret', async () => {
    const wrongSecret = await requestToken({ grant_type: 'client_credentials', client_id: 'tienda-a-backend', client_secret: 'nope' });
    const unknown = await requestToken({ grant_type: 'client_credentials', client_id: 'ghost', client_secret: 'nope' });
    assert.equal(wrongSecret.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrongSecret.json(), await unknown.json());
  });

  it('refuses scopes the client is not allowed to have', async () => {
    const res = await requestToken({
      grant_type: 'client_credentials',
      client_id: 'tienda-a-agent',
      client_secret: 'dev-secret-agent-a',
      scope: 'payments:refund',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_scope');
  });

  it('rejects other grant types and missing credentials', async () => {
    assert.equal((await (await requestToken({ grant_type: 'password' })).json()).error, 'unsupported_grant_type');
    assert.equal((await (await requestToken({ grant_type: 'client_credentials' })).json()).error, 'invalid_request');
  });

  it('publishes only the public key in the JWKS', async () => {
    const { keys } = await (await fetch(`${server.baseUrl}/.well-known/jwks.json`)).json();
    assert.equal(keys.length, 1);
    assert.equal(keys[0].alg, 'ES256');
    assert.equal(keys[0].d, undefined, 'private key material must never be published');
  });
});

describe('Bearer authentication on /api/v1/payments', () => {
  let server: Server;
  before(async () => {
    server = await startTestServer();
  });
  after(() => server.close());

  const list = (authorization?: string) =>
    fetch(`${server.baseUrl}/api/v1/payments`, { headers: authorization ? { authorization } : {} });

  /** Builds a token like the real issuer does, letting each test break one property. */
  async function forge(overrides: { key?: CryptoKey; aud?: string; exp?: number; merchant?: string; typ?: string } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ merchant_id: overrides.merchant ?? 'tienda_A', scope: 'payments:read' })
      .setProtectedHeader({ alg: 'ES256', typ: overrides.typ ?? 'at+jwt' })
      .setIssuer(TOKEN_CONFIG.issuer)
      .setAudience(overrides.aud ?? TOKEN_CONFIG.audience)
      .setSubject('tienda-a-backend')
      .setIssuedAt(now)
      .setExpirationTime(overrides.exp ?? now + 60)
      .sign(overrides.key ?? server.signingKey.privateKey);
  }

  async function assertInvalidToken(token: string) {
    const res = await list(`Bearer ${token}`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
    assert.equal((await res.json()).error.code, 'INVALID_TOKEN');
  }

  it('accepts a correctly signed token', async () => {
    assert.equal((await list(`Bearer ${await forge()}`)).status, 200);
  });

  it('rejects a missing or malformed Authorization header (4.2)', async () => {
    assert.equal((await list()).status, 401);
    assert.equal((await list('Basic abc')).status, 401);
    assert.equal((await list('Bearer not-a-jwt')).status, 401);
  });

  it('rejects an expired token (4.2)', async () => {
    await assertInvalidToken(await forge({ exp: Math.floor(Date.now() / 1000) - 60 }));
  });

  it('rejects a token signed by another key', async () => {
    const attacker = await generateKeyPair('ES256');
    await assertInvalidToken(await forge({ key: attacker.privateKey }));
  });

  it('rejects a token issued for another API (audience)', async () => {
    await assertInvalidToken(await forge({ aud: 'reports-api' }));
  });

  it('rejects an ID token or other JWT type used as an access token', async () => {
    await assertInvalidToken(await forge({ typ: 'JWT' }));
  });

  it('rejects a tampered payload (changing merchant_id breaks the signature)', async () => {
    const [header, , signature] = (await forge()).split('.');
    const evilPayload = Buffer.from(
      JSON.stringify({ merchant_id: 'tienda_B', scope: 'payments:read', sub: 'x', iss: TOKEN_CONFIG.issuer, aud: TOKEN_CONFIG.audience, exp: 9999999999 }),
    ).toString('base64url');
    await assertInvalidToken(`${header}.${evilPayload}.${signature}`);
  });

  it('rejects alg=none (unsigned) tokens', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).toString('base64url');
    const payload = (await forge()).split('.')[1];
    await assertInvalidToken(`${header}.${payload}.x`);
  });
});

describe('Scope authorization (4.3)', () => {
  let server: Server;
  before(async () => {
    server = await startTestServer();
  });
  after(() => server.close());

  const call = (method: string, path: string, token: string, body?: unknown) =>
    fetch(server.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it('lets the AI agent charge but not refund', async () => {
    const agent = await server.tokenFor('tienda-a-agent');
    const created = await call('POST', '/api/v1/payments', agent, { amountMinor: 5000, currency: 'COP' });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const refund = await call('POST', `/api/v1/payments/${id}/refunds`, agent, { amountMinor: 1000 });
    assert.equal(refund.status, 403);
    assert.equal(
      refund.headers.get('www-authenticate'),
      'Bearer realm="payments-mcp", error="insufficient_scope", scope="payments:refund"',
    );
    assert.equal((await refund.json()).error.details.requiredScope, 'payments:refund');
  });

  it('a read-only token cannot create payments', async () => {
    const readOnly = await server.tokenFor('tienda-a-backend', 'payments:read');
    assert.equal((await call('GET', '/api/v1/payments', readOnly)).status, 200);
    assert.equal((await call('POST', '/api/v1/payments', readOnly, { amountMinor: 1, currency: 'COP' })).status, 403);
  });

  it('takes the merchant from the token, so tienda_B cannot see tienda_A payments', async () => {
    const a = await server.tokenFor('tienda-a-backend');
    const b = await server.tokenFor('tienda-b-backend');
    const { id } = await (await call('POST', '/api/v1/payments', a, { amountMinor: 700, currency: 'COP' })).json();
    assert.equal((await call('GET', `/api/v1/payments/${id}`, a)).status, 200);
    assert.equal((await call('GET', `/api/v1/payments/${id}`, b)).status, 404);
  });
});

describe('signing key from configuration (production path)', () => {
  it('imports a private JWK, publishes only its public part and verifies its own tokens', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const key = await loadSigningKey(JSON.stringify({ ...(await exportJWK(privateKey)), kid: 'prod-2026-10' }));
    assert.equal(key.kid, 'prod-2026-10');
    assert.equal(key.publicJwk.d, undefined);

    const token = await new SignJWT({ merchant_id: 'tienda_A', scope: 'payments:read unknown:scope' })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: key.kid })
      .setIssuer('iss').setAudience('aud').setSubject('c1').setExpirationTime('1m')
      .sign(key.privateKey);
    const auth = await new JwtVerifier({ key: key.publicKey, issuer: 'iss', audience: 'aud' }).verify(token);
    assert.deepEqual([...auth.scopes], ['payments:read'], 'unknown scopes are dropped');
  });

  it('rejects a validly signed token that lacks the merchant claim', async () => {
    const key = await loadSigningKey();
    const token = await new SignJWT({ scope: 'payments:read' })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt' })
      .setIssuer('iss').setAudience('aud').setSubject('c1').setExpirationTime('1m')
      .sign(key.privateKey);
    await assert.rejects(new JwtVerifier({ key: key.publicKey, issuer: 'iss', audience: 'aud' }).verify(token), /missing required claims/);
  });
});

describe('secret hashing', () => {
  it('verifies the right secret only and rejects malformed hashes', async () => {
    const stored = await hashSecret('s3cret');
    assert.equal(await verifySecret('s3cret', stored), true);
    assert.equal(await verifySecret('S3cret', stored), false);
    assert.equal(await verifySecret('s3cret', 'md5$abc'), false);
    assert.notEqual(await hashSecret('s3cret'), stored, 'random salt: same secret, different hash');
  });
});
