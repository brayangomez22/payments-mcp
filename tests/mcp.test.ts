import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, ClientCredentialsProvider, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
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
    const token = await server.tokenFor(clientId, { resource: server.mcpResource });
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
    const token = await server.tokenFor('tienda-a-backend', { resource: server.mcpResource });
    const res = await fetch(`${server.baseUrl}/mcp`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });
});

describe('MCP authorization (spec discovery, audiences, scopes)', () => {
  let server: Server;
  before(async () => {
    server = await startTestServer();
  });
  after(() => server.close());

  const post = (path: string, token?: string) =>
    fetch(server.baseUrl + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('401 points to the Protected Resource Metadata, which points to the authorization server', async () => {
    const res = await post('/mcp');
    assert.equal(res.status, 401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    assert.equal(metadataUrl, `${server.baseUrl}/.well-known/oauth-protected-resource/mcp`);

    const prm = await (await fetch(metadataUrl)).json();
    assert.equal(prm.resource, server.mcpResource);
    assert.deepEqual(prm.authorization_servers, [server.issuer]);

    const as = await (await fetch(`${server.issuer}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.issuer, server.issuer, 'RFC 8414: issuer must equal the authorization server URL');
    assert.equal(as.token_endpoint, `${server.issuer}/oauth/token`);
    assert.deepEqual(as.grant_types_supported, ['client_credentials']);
    const authorize = await fetch(as.authorization_endpoint);
    assert.equal((await authorize.json()).error, 'unsupported_response_type');
  });

  it('binds tokens to one resource: a REST token fails on /mcp and an MCP token fails on REST', async () => {
    const restToken = await server.tokenFor('tienda-a-backend');
    const mcpToken = await server.tokenFor('tienda-a-backend', { resource: server.mcpResource });

    const restOnMcp = await post('/mcp', restToken);
    assert.equal(restOnMcp.status, 401);
    assert.match(restOnMcp.headers.get('www-authenticate') ?? '', /error="invalid_token"/);

    const mcpOnRest = await fetch(`${server.baseUrl}/api/v1/payments`, { headers: { authorization: `Bearer ${mcpToken}` } });
    assert.equal(mcpOnRest.status, 401);
  });

  it('refuses tokens for unknown resources (RFC 8707 invalid_target)', async () => {
    const res = await fetch(`${server.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'tienda-a-backend',
        client_secret: 'dev-secret-tienda-a',
        resource: 'https://evil.example.com/mcp',
      }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_target');
  });

  it('only registers the tools the token has scopes for (5.3)', async () => {
    const connectWith = async (scope: string) => {
      const token = await server.tokenFor('tienda-a-backend', { scope, resource: server.mcpResource });
      const client = new Client({ name: 'scoped', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.mcpResource), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
      );
      return client;
    };

    const reader = await connectWith('payments:read');
    assert.deepEqual((await reader.listTools()).tools.map((t) => t.name).sort(), ['get_payment', 'list_payments']);
    await reader.close();

    const writerOnly = await connectWith('payments:write');
    const call = await writerOnly
      .callTool({ name: 'get_payment', arguments: { paymentId: crypto.randomUUID() } })
      .then((r) => ({ ok: !r.isError }), () => ({ ok: false }));
    assert.equal(call.ok, false, 'a token without payments:read cannot call read tools');
    await writerOnly.close();
  });

  it('end to end: a client with only the URL and its credentials discovers everything and connects', async () => {
    const client = new Client({ name: 'autonomous-agent', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpResource), {
      authProvider: new ClientCredentialsProvider({
        clientId: 'tienda-a-agent',
        clientSecret: 'dev-secret-agent-a',
        expectedIssuer: server.issuer,
      }),
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'get_payment'));
    await client.close();
  });
});
