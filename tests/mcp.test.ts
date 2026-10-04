import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { DEV_SECRETS } from './helpers/fixtures.js';
import { startTestServer } from './helpers/fixtures.js';

type Server = Awaited<ReturnType<typeof startTestServer>>;

describe('MCP server (/mcp)', () => {
  let server: Server;
  const clients: Client[] = [];

  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
  });

  /** A real MCP client (what Claude Desktop or an agent would run), authenticated as `clientId`. */
  async function connect(clientId: keyof typeof DEV_SECRETS): Promise<Client> {
    const token = await server.tokenFor(clientId);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return client;
  }

  /** Creates a payment through the service, as tienda_A, to have something to read. */
  const seedPayment = (amountMinor: number) =>
    server.service.create({ merchantId: 'tienda_A' }, { amountMinor, currency: 'COP' }, crypto.randomUUID());

  const textOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
    JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? 'null');

  it('rejects connections without a valid token (5.2)', async () => {
    const res = await fetch(`${server.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer/);
  });

  it('lists the read tools with JSON Schema derived from Valibot (5.1)', async () => {
    const client = await connect('tienda-a-backend');
    const { tools } = await client.listTools();
    const getPayment = tools.find((t) => t.name === 'get_payment');
    assert.ok(getPayment);
    assert.equal(getPayment.annotations?.readOnlyHint, true);
    assert.deepEqual(getPayment.inputSchema.required, ['paymentId']);
    assert.ok(!JSON.stringify(tools).includes('merchant'), 'no tool may take a merchant argument');
  });

  it('get_payment returns text and structured content', async () => {
    const created = await seedPayment(25_000);
    const client = await connect('tienda-a-backend');
    const result = await client.callTool({ name: 'get_payment', arguments: { paymentId: created.id } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, created);
    assert.deepEqual(textOf(result), created);
  });

  it('acts as the merchant in the token: tienda_B cannot read tienda_A payments', async () => {
    const created = await seedPayment(9_000);
    const client = await connect('tienda-b-backend');
    const result = await client.callTool({ name: 'get_payment', arguments: { paymentId: created.id } });
    assert.equal(result.isError, true);
    assert.equal(textOf(result).error.code, 'PAYMENT_NOT_FOUND');
  });

  it('rejects invalid arguments before the handler runs (5.4)', async () => {
    const client = await connect('tienda-a-backend');
    const notUuid = await client.callTool({ name: 'get_payment', arguments: { paymentId: '123' } });
    assert.equal(notUuid.isError, true);
    const smuggled = await client.callTool({
      name: 'get_payment',
      arguments: { paymentId: crypto.randomUUID(), merchantId: 'tienda_B' },
    });
    assert.equal(smuggled.isError, true, 'extra keys such as merchantId are rejected');
  });

  it('list_payments paginates with a cursor', async () => {
    for (const amount of [101, 102, 103]) await seedPayment(amount);
    const client = await connect('tienda-a-backend');
    const first = await client.callTool({ name: 'list_payments', arguments: { limit: 2 } });
    const page1 = first.structuredContent as { data: unknown[]; nextCursor: string };
    assert.equal(page1.data.length, 2);
    const second = await client.callTool({ name: 'list_payments', arguments: { limit: 2, cursor: page1.nextCursor } });
    assert.equal(second.isError, undefined);
  });

  it('hides internal failures from the model (5.6)', async () => {
    const original = server.store.repo.findById;
    server.store.repo.findById = async () => {
      throw new Error('relation "payments" does not exist');
    };
    try {
      const client = await connect('tienda-a-backend');
      const result = await client.callTool({ name: 'get_payment', arguments: { paymentId: crypto.randomUUID() } });
      assert.equal(result.isError, true);
      assert.equal(textOf(result).error.code, 'INTERNAL_ERROR');
      assert.doesNotMatch(JSON.stringify(result), /relation|payments" does not exist/);
    } finally {
      server.store.repo.findById = original;
    }
  });

  it('answers 405 to GET/DELETE because the server is stateless', async () => {
    const token = await server.tokenFor('tienda-a-backend');
    const res = await fetch(`${server.baseUrl}/mcp`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });
});
