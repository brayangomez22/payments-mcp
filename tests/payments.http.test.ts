import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestServer } from './helpers/fixtures.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;

describe('Payments HTTP API', () => {
  let server: Server;
  before(async () => {
    server = await startTestServer();
  });
  after(() => server.close());

  function call(method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
    return fetch(server.baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-merchant-id': 'm_1', ...init.headers },
      ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
    });
  }

  const create = (body: unknown, key = crypto.randomUUID()) =>
    call('POST', '/api/v1/payments', { body, headers: { 'idempotency-key': key } });

  it('creates a payment with 201 and a Location header', async () => {
    const res = await create({ amountMinor: 150_000, currency: 'COP', description: 'Pedido #1' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, 'succeeded');
    assert.equal(res.headers.get('location'), `/api/v1/payments/${body.id}`);
    assert.ok(res.headers.get('x-request-id'));
  });

  it('returns 202 when the provider outcome is unknown', async () => {
    const res = await create({ amountMinor: 1099, currency: 'USD' });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).status, 'pending');
  });

  it('requires an Idempotency-Key', async () => {
    const res = await call('POST', '/api/v1/payments', { body: { amountMinor: 100, currency: 'COP' } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns 422 when a key is reused with another body', async () => {
    const key = crypto.randomUUID();
    await create({ amountMinor: 100, currency: 'COP' }, key);
    const res = await create({ amountMinor: 200, currency: 'COP' }, key);
    assert.equal(res.status, 422);
  });

  it('validates the body and rejects unknown fields', async () => {
    const res = await create({ amountMinor: 10.5, currency: 'EUR', merchantId: 'm_2' });
    assert.equal(res.status, 400);
    const { error } = await res.json();
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.ok(error.details.length >= 2);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await call('POST', '/api/v1/payments', { body: '{oops', headers: { 'idempotency-key': 'key-00000001' } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_JSON');
  });

  it('requires a merchant identity', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/payments`, { headers: {} });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  });

  it('gets, lists and refunds', async () => {
    const created = await (await create({ amountMinor: 10_000, currency: 'COP' })).json();

    const got = await call('GET', `/api/v1/payments/${created.id}`);
    assert.equal(got.status, 200);

    const list = await call('GET', '/api/v1/payments?limit=1&status=succeeded');
    const page = await list.json();
    assert.equal(page.data.length, 1);
    assert.ok(page.nextCursor);

    const refund = await call('POST', `/api/v1/payments/${created.id}/refunds`, {
      body: { amountMinor: 10_000 },
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    assert.equal(refund.status, 201);
    assert.equal((await refund.json()).payment.status, 'refunded');
  });

  it('returns 404 for another merchant and 400 for a non-UUID id', async () => {
    const created = await (await create({ amountMinor: 500, currency: 'COP' })).json();
    const foreign = await call('GET', `/api/v1/payments/${created.id}`, { headers: { 'x-merchant-id': 'm_2' } });
    assert.equal(foreign.status, 404);
    const bad = await call('GET', '/api/v1/payments/123');
    assert.equal(bad.status, 400);
  });

  it('rejects limit above 100', async () => {
    const res = await call('GET', '/api/v1/payments?limit=101');
    assert.equal(res.status, 400);
  });

  it('serves health, OpenAPI and unknown routes', async () => {
    assert.equal((await fetch(`${server.baseUrl}/health/live`)).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/health/ready`)).status, 200);
    const spec = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
    assert.equal(spec.openapi, '3.1.0');
    assert.equal((await fetch(`${server.baseUrl}/docs/`)).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/nope`)).status, 404);
  });

  it('propagates a valid incoming X-Request-Id', async () => {
    const res = await call('GET', '/api/v1/payments', { headers: { 'x-request-id': 'trace-abc-123' } });
    assert.equal(res.headers.get('x-request-id'), 'trace-abc-123');
  });
});

describe('Readiness and unexpected errors', () => {
  it('reports 503 when a dependency is down', async () => {
    const server = await startTestServer({
      ready: async () => {
        throw new Error('db down');
      },
    });
    try {
      assert.equal((await fetch(`${server.baseUrl}/health/ready`)).status, 503);
    } finally {
      await server.close();
    }
  });

  it('hides internal errors behind a generic 500', async () => {
    const server = await startTestServer();
    server.store.repo.findById = async () => {
      throw new Error('relation "payments" does not exist');
    };
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/payments/${crypto.randomUUID()}`, {
        headers: { 'x-merchant-id': 'm_1' },
      });
      assert.equal(res.status, 500);
      const { error } = await res.json();
      assert.equal(error.code, 'INTERNAL_ERROR');
      assert.doesNotMatch(error.message, /relation/);
    } finally {
      await server.close();
    }
  });
});
