import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { OutboxRelay } from '../src/core/events/outbox-relay.js';
import { Metrics } from '../src/core/metrics.js';
import { silentLogger, startTestServer } from './helpers/fixtures.js';

describe('Prometheus metrics (/metrics)', () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  let auth: string;
  before(async () => {
    server = await startTestServer();
    auth = `Bearer ${await server.tokenFor('tienda-a-backend')}`;
  });
  after(() => server.close());

  const scrape = async () => {
    const res = await fetch(`${server.baseUrl}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
    return res.text();
  };

  /** Value of one series, e.g. sample(text, 'payments_total{status="failed"}'). */
  const sample = (text: string, series: string): number => {
    const line = text.split('\n').find((l) => l.startsWith(`${series} `));
    return line ? Number(line.slice(series.length + 1)) : 0;
  };

  it('labels HTTP latency with the route pattern, not the URL (7.1)', async () => {
    const id = crypto.randomUUID();
    await fetch(`${server.baseUrl}/api/v1/payments/${id}`, { headers: { authorization: auth } });
    await fetch(`${server.baseUrl}/no-such-route`);
    await fetch(`${server.baseUrl}/api/v1/payments/${id}`); // no token: rejected before any route
    const text = await scrape();

    assert.equal(
      sample(text, 'http_request_duration_seconds_count{method="GET",route="/api/v1/payments/:id",status_code="404"}'),
      1,
    );
    assert.equal(sample(text, 'http_request_duration_seconds_count{method="GET",route="unmatched",status_code="404"}'), 1);
    assert.equal(sample(text, 'http_request_duration_seconds_count{method="GET",route="/api/v1/payments/*",status_code="401"}'), 1);
    assert.ok(!text.includes(id), 'a payment id never becomes a label');
  });

  it('counts payment status transitions (7.1)', async () => {
    const create = (amountMinor: number) =>
      fetch(`${server.baseUrl}/api/v1/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth, 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ amountMinor, currency: 'COP' }),
      });
    const before = await scrape();
    await create(5000);
    await create(1013); // declined by the fake provider
    const text = await scrape();

    const delta = (status: string) =>
      sample(text, `payments_total{status="${status}"}`) - sample(before, `payments_total{status="${status}"}`);
    assert.equal(delta('pending'), 2);
    assert.equal(delta('succeeded'), 1);
    assert.equal(delta('failed'), 1);
  });

  it('counts MCP tool calls by tool and outcome (7.1)', async () => {
    const token = await server.tokenFor('tienda-a-agent', { resource: server.mcpResource });
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    await client.callTool({ name: 'get_payment', arguments: { paymentId: crypto.randomUUID() } });
    await client.callTool({ name: 'list_payments', arguments: {} });
    await client.close();
    const text = await scrape();

    assert.equal(sample(text, 'mcp_tool_calls_total{tool="get_payment",outcome="domain_error"}'), 1);
    assert.equal(sample(text, 'mcp_tool_calls_total{tool="list_payments",outcome="ok"}'), 1);
  });
});

describe('Metrics', () => {
  it('reports the outbox backlog on every scrape', async () => {
    const metrics = new Metrics({ defaultMetrics: false });
    let pending = 3;
    metrics.trackOutboxBacklog(async () => pending);
    assert.match(await metrics.registry.metrics(), /^outbox_pending_events 3$/m);
    pending = 0;
    assert.match(await metrics.registry.metrics(), /^outbox_pending_events 0$/m);
  });

  it('counts published events and failed relay passes', async () => {
    const metrics = new Metrics({ defaultMetrics: false });
    let down = false;
    const relay = new OutboxRelay({
      store: {
        drain: async (_limit, publish) => {
          const ids = await publish([{ id: '1', topic: 't', payload: {} }]);
          return { claimed: 1, published: ids.length };
        },
      },
      publisher: {
        publish: async (events) => {
          if (down) throw new Error('down');
          return events.map((e) => e.id);
        },
      },
      logger: silentLogger,
      intervalMs: 5,
      metrics,
    });
    await relay.runOnce();
    down = true;
    relay.start();
    await new Promise((r) => setTimeout(r, 15));
    await relay.stop();

    const text = await metrics.registry.metrics();
    assert.match(text, /^outbox_events_published_total 1$/m);
    assert.match(text, /^outbox_relay_errors_total [1-9]\d*$/m);
  });

  it('collects the default process metrics unless disabled', async () => {
    assert.match(await new Metrics().registry.metrics(), /process_cpu_user_seconds_total/);
  });
});
