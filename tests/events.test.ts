import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { DrainResult, EventPublisher, OutboxEvent, OutboxMessage, OutboxStore } from '../src/core/events/outbox.js';
import { OutboxRelay } from '../src/core/events/outbox-relay.js';
import { SqsEventPublisher } from '../src/integrations/sqs/sqs-publisher.js';
import { createService, silentLogger, startTestServer, tickingClock } from './helpers/fixtures.js';

const merchant = { merchantId: 'm_1', requestId: 'req-1' };
const topics = (events: OutboxMessage[]) => events.map((e) => e.topic);

describe('Payment events in the outbox', () => {
  it('records pending, then the provider outcome, with the event fields (6.1)', async () => {
    const { service, store } = createService({ clock: tickingClock() });
    const p = await service.create(merchant, { amountMinor: 5000, currency: 'COP' }, 'key-00000001');

    assert.deepEqual(topics(store.events), ['payment.pending', 'payment.succeeded']);
    const last = store.events[1]?.payload;
    assert.equal(last?.['paymentId'], p.id);
    assert.equal(last?.['merchantId'], 'm_1');
    assert.equal(last?.['status'], 'succeeded');
    assert.equal(last?.['requestId'], 'req-1');
    assert.equal(last?.['occurredAt'], p.updatedAt);
    assert.notEqual(store.events[0]?.payload['eventId'], last?.['eventId'], 'each event has its own id');
  });

  it('records a declined charge as payment.failed', async () => {
    const { service, store } = createService();
    await service.create(merchant, { amountMinor: 1013, currency: 'USD' }, 'key-00000001');
    assert.deepEqual(topics(store.events), ['payment.pending', 'payment.failed']);
  });

  it('records only payment.pending when the provider outcome is unknown', async () => {
    const { service, store } = createService({ providerTimeoutMs: 10 });
    await service.create(merchant, { amountMinor: 1099, currency: 'USD' }, 'key-00000001');
    assert.deepEqual(topics(store.events), ['payment.pending']);
  });

  it('records refunds as partially_refunded, then refunded', async () => {
    const { service, store } = createService();
    const p = await service.create(merchant, { amountMinor: 10_000, currency: 'COP' }, 'key-00000001');
    await service.refund(merchant, p.id, { amountMinor: 4000 }, 'key-00000002');
    await service.refund(merchant, p.id, { amountMinor: 6000 }, 'key-00000003');
    assert.deepEqual(topics(store.events).slice(2), ['payment.partially_refunded', 'payment.refunded']);
  });

  it('records nothing for an idempotent replay', async () => {
    const { service, store } = createService();
    const input = { amountMinor: 5000, currency: 'COP' as const };
    await service.create(merchant, input, 'key-00000001');
    await service.create(merchant, input, 'key-00000001');
    assert.equal(store.events.length, 2);
  });

  it('records nothing when the refund fails at the provider', async () => {
    const { service, store, provider } = createService();
    const p = await service.create(merchant, { amountMinor: 10_000, currency: 'COP' }, 'key-00000001');
    provider.refund = async () => {
      throw new Error('boom');
    };
    await assert.rejects(service.refund(merchant, p.id, { amountMinor: 100 }, 'key-00000002'));
    assert.equal(store.events.length, 2);
  });
});

describe('requestId propagation into events', () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  before(async () => {
    server = await startTestServer();
  });
  after(() => server.close());

  it('REST: the X-Request-Id of the request is in the event', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await server.tokenFor('tienda-a-backend')}`,
        'idempotency-key': crypto.randomUUID(),
        'x-request-id': 'rest-trace-1',
      },
      body: JSON.stringify({ amountMinor: 2000, currency: 'COP' }),
    });
    assert.equal(res.status, 201);
    const { id } = await res.json();
    const mine = server.store.events.filter((e) => e.payload['paymentId'] === id);
    assert.deepEqual(
      mine.map((e) => e.payload['requestId']),
      ['rest-trace-1', 'rest-trace-1'],
    );
  });

  it('MCP: a tool call carries the requestId of its HTTP request', async () => {
    const token = await server.tokenFor('tienda-a-agent', { resource: server.mcpResource });
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}`, 'x-request-id': 'mcp-trace-1' } },
      }),
    );
    const result = await client.callTool({
      name: 'create_payment',
      arguments: { amountMinor: 3000, currency: 'COP', idempotencyKey: crypto.randomUUID() },
    });
    const { id } = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? '{}');
    await client.close();
    const mine = server.store.events.filter((e) => e.payload['paymentId'] === id);
    assert.equal(mine.length, 2);
    assert.ok(mine.every((e) => e.payload['requestId'] === 'mcp-trace-1'));
  });
});

/** Mimics PgOutboxStore: pending rows, marked published only for the ids `publish` returns. */
class FakeOutboxStore implements OutboxStore {
  readonly rows: Array<OutboxEvent & { published: boolean }> = [];

  add(count: number): void {
    for (let i = 0; i < count; i++) {
      const id = String(this.rows.length + 1);
      this.rows.push({ id, topic: 'payment.succeeded', payload: { eventId: id }, published: false });
    }
  }
  pending(): string[] {
    return this.rows.filter((r) => !r.published).map((r) => r.id);
  }
  async drain(limit: number, publish: (events: OutboxEvent[]) => Promise<string[]>): Promise<DrainResult> {
    const batch = this.rows.filter((r) => !r.published).slice(0, limit);
    if (batch.length === 0) return { claimed: 0, published: 0 };
    const ids = await publish(batch.map(({ id, topic, payload }) => ({ id, topic, payload })));
    for (const r of batch) if (ids.includes(r.id)) r.published = true;
    return { claimed: batch.length, published: ids.length };
  }
}

class FakePublisher implements EventPublisher {
  readonly sent: OutboxEvent[] = [];
  reject = new Set<string>();
  down = false;

  async publish(events: OutboxEvent[]): Promise<string[]> {
    if (this.down) throw new Error('SQS unavailable');
    const ok = events.filter((e) => !this.reject.has(e.id));
    this.sent.push(...ok);
    return ok.map((e) => e.id);
  }
}

describe('OutboxRelay', () => {
  const setup = (batchSize?: number) => {
    const store = new FakeOutboxStore();
    const publisher = new FakePublisher();
    const relay = new OutboxRelay({
      store,
      publisher,
      logger: silentLogger,
      intervalMs: 5,
      ...(batchSize ? { batchSize } : {}),
    });
    return { store, publisher, relay };
  };

  it('publishes pending events and marks them published', async () => {
    const { store, publisher, relay } = setup();
    store.add(3);
    assert.deepEqual(await relay.runOnce(), { claimed: 3, published: 3 });
    assert.deepEqual(store.pending(), []);
    assert.equal(publisher.sent.length, 3);
    assert.deepEqual(await relay.runOnce(), { claimed: 0, published: 0 });
  });

  it('keeps events the broker rejected, and sends them on a later pass (6.2)', async () => {
    const { store, publisher, relay } = setup();
    store.add(3);
    publisher.reject.add('2');
    assert.deepEqual(await relay.runOnce(), { claimed: 3, published: 2 });
    assert.deepEqual(store.pending(), ['2']);

    publisher.reject.clear();
    await relay.runOnce();
    assert.deepEqual(store.pending(), []);
  });

  it('leaves everything pending when the broker is down (6.2)', async () => {
    const { store, publisher, relay } = setup();
    store.add(2);
    publisher.down = true;
    await assert.rejects(relay.runOnce(), /SQS unavailable/);
    assert.deepEqual(store.pending(), ['1', '2']);
  });

  it('never claims more than the SQS batch limit of 10', async () => {
    const { store, relay } = setup(50);
    store.add(12);
    assert.deepEqual(await relay.runOnce(), { claimed: 10, published: 10 });
  });

  it('runs in the background, survives broker errors and drains a backlog', async () => {
    const { store, publisher, relay } = setup(2);
    store.add(5);
    publisher.down = true;
    relay.start();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.pending().length, 5, 'nothing published while the broker is down');

    publisher.down = false;
    for (let i = 0; i < 50 && store.pending().length > 0; i++) await new Promise((r) => setTimeout(r, 5));
    await relay.stop();
    assert.deepEqual(store.pending(), []);
    assert.deepEqual(
      publisher.sent.map((e) => e.id),
      ['1', '2', '3', '4', '5'],
    );
  });
});

describe('SqsEventPublisher', () => {
  it('sends one batch with the topic attribute and returns only the successful ids', async () => {
    const commands: SendMessageBatchCommand[] = [];
    const client = {
      send: async (command: SendMessageBatchCommand) => {
        commands.push(command);
        return { Successful: [{ Id: '7' }], Failed: [{ Id: '8', Code: 'InternalError', SenderFault: false }] };
      },
    };
    const publisher = new SqsEventPublisher(client as never, 'http://sqs.local/000000000000/payments-events');
    const ids = await publisher.publish([
      { id: '7', topic: 'payment.succeeded', payload: { paymentId: 'p1' } },
      { id: '8', topic: 'payment.failed', payload: { paymentId: 'p2' } },
    ]);

    assert.deepEqual(ids, ['7']);
    const input = commands[0]?.input;
    assert.equal(input?.QueueUrl, 'http://sqs.local/000000000000/payments-events');
    assert.deepEqual(input?.Entries?.[0], {
      Id: '7',
      MessageBody: '{"paymentId":"p1"}',
      MessageAttributes: { topic: { DataType: 'String', StringValue: 'payment.succeeded' } },
    });
  });
});
