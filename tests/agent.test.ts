import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toToolResult } from '../src/agent/mcp-bridge.js';
import { DEFAULT_MODEL, PaymentsAgent, type MessagesApi, type ToolCall } from '../src/agent/payments-agent.js';
import { startTestServer } from './helpers/fixtures.js';

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Block = Anthropic.Beta.BetaContentBlock;

const text = (t: string): Block => ({ type: 'text', text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: Record<string, unknown>): Block =>
  ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } }) as Block;

/** A scripted Claude: each call returns the next response and records the request it got. */
function scriptedClaude(...turns: Array<{ stop: string; content: Block[] }>) {
  const requests: Params[] = [];
  const api: MessagesApi = {
    async create(params) {
      requests.push(structuredClone(params));
      const turn = turns.shift();
      if (!turn) throw new Error('script exhausted');
      return { id: `msg_${requests.length}`, type: 'message', role: 'assistant', content: turn.content, stop_reason: turn.stop } as never;
    },
  };
  return { api, requests };
}

/** The tool_result blocks the agent sent in a request's last user message. */
function lastToolResults(params: Params | undefined): Anthropic.Beta.BetaToolResultBlockParam[] {
  const last = params?.messages.at(-1);
  return Array.isArray(last?.content) ? (last.content as Anthropic.Beta.BetaToolResultBlockParam[]) : [];
}

describe('PaymentsAgent over the real MCP server', () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  const clients: Client[] = [];
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
  });

  async function mcpAs(clientId: 'tienda-a-backend' | 'tienda-a-agent'): Promise<Client> {
    const token = await server.tokenFor(clientId, { resource: server.mcpResource });
    const client = new Client({ name: 'agent-test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.mcpResource), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return client;
  }

  const seed = (amountMinor: number) =>
    server.service.create({ merchantId: 'tienda_A' }, { amountMinor, currency: 'COP' }, crypto.randomUUID());

  it('offers Claude exactly the MCP tools of the token, with their schemas', async () => {
    const claude = scriptedClaude({ stop: 'end_turn', content: [text('Hola')] });
    const agent = new PaymentsAgent({ messages: claude.api, mcp: await mcpAs('tienda-a-agent') });
    assert.equal(await agent.ask('hola'), 'Hola');

    const req = claude.requests[0];
    assert.equal(req?.model, DEFAULT_MODEL);
    assert.equal(req?.fallbacks, 'default');
    const tools = (req?.tools ?? []) as Anthropic.Beta.BetaTool[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ['create_payment', 'get_payment', 'list_payments']);
    assert.ok(tools.every((t) => t.input_schema.type === 'object' && t.description));
  });

  it('runs the tool over MCP, returns the result to Claude and gets the final answer', async () => {
    const payment = await seed(42_000);
    const claude = scriptedClaude(
      { stop: 'tool_use', content: [text('Busco el pago.'), toolUse('tu_1', 'get_payment', { paymentId: payment.id })] },
      { stop: 'end_turn', content: [text('El pago fue exitoso: $42.000 COP.')] },
    );
    const seen: ToolCall[] = [];
    const agent = new PaymentsAgent({ messages: claude.api, mcp: await mcpAs('tienda-a-agent'), onToolCall: (c) => seen.push(c) });

    assert.equal(await agent.ask(`¿Cómo va el pago ${payment.id}?`), 'El pago fue exitoso: $42.000 COP.');
    assert.deepEqual(seen, [{ name: 'get_payment', input: { paymentId: payment.id } }]);

    const [result] = lastToolResults(claude.requests[1]);
    assert.equal(result?.tool_use_id, 'tu_1');
    assert.equal(result?.is_error, undefined);
    assert.equal(JSON.parse(String(result?.content)).amountMinor, 42_000);
    // user → assistant (unchanged, with its tool_use) → user (tool results).
    const [, assistant] = claude.requests[1]?.messages ?? [];
    assert.equal(assistant?.role, 'assistant');
    assert.deepEqual(assistant?.content, [text('Busco el pago.'), toolUse('tu_1', 'get_payment', { paymentId: payment.id })]);
    assert.equal(claude.requests[1]?.messages.length, 3);
  });

  it('runs parallel tool calls and returns all results in one message', async () => {
    const [a, b] = [await seed(1000), await seed(2000)];
    const claude = scriptedClaude(
      { stop: 'tool_use', content: [toolUse('t_a', 'get_payment', { paymentId: a.id }), toolUse('t_b', 'get_payment', { paymentId: b.id })] },
      { stop: 'end_turn', content: [text('listo')] },
    );
    const agent = new PaymentsAgent({ messages: claude.api, mcp: await mcpAs('tienda-a-agent') });
    await agent.ask('compara');
    assert.deepEqual(
      lastToolResults(claude.requests[1]).map((r) => r.tool_use_id),
      ['t_a', 't_b'],
    );
  });

  it('passes MCP domain errors to Claude as is_error so it can recover', async () => {
    const claude = scriptedClaude(
      { stop: 'tool_use', content: [toolUse('tu_1', 'get_payment', { paymentId: crypto.randomUUID() })] },
      { stop: 'end_turn', content: [text('No encontré ese pago.')] },
    );
    const agent = new PaymentsAgent({ messages: claude.api, mcp: await mcpAs('tienda-a-agent') });
    await agent.ask('busca');
    const [result] = lastToolResults(claude.requests[1]);
    assert.equal(result?.is_error, true);
    assert.match(String(result?.content), /PAYMENT_NOT_FOUND/);
  });

  describe('refunds: the server preview plus the human approval in the host', () => {
    const refundTurns = (paymentId: string) => [
      { stop: 'tool_use', content: [toolUse('p', 'refund_payment', { paymentId, amountMinor: 1000, idempotencyKey: 'refund-key-0001' })] },
      { stop: 'end_turn', content: [text('Esta es la vista previa. ¿Confirmas?')] },
      {
        stop: 'tool_use',
        content: [toolUse('c', 'refund_payment', { paymentId, amountMinor: 1000, idempotencyKey: 'refund-key-0001', confirm: true })],
      },
      { stop: 'end_turn', content: [text('Hecho.')] },
    ];

    it('the preview runs without asking; the real refund waits for the person', async () => {
      const payment = await seed(5000);
      const claude = scriptedClaude(...refundTurns(payment.id));
      const asked: ToolCall[] = [];
      const agent = new PaymentsAgent({
        messages: claude.api,
        mcp: await mcpAs('tienda-a-backend'),
        approve: async (call) => {
          asked.push(call);
          return true;
        },
      });

      await agent.ask('reembolsa 1000');
      assert.equal(asked.length, 0, 'a preview never needs approval');
      assert.equal((await server.service.get({ merchantId: 'tienda_A' }, payment.id)).refundedMinor, 0);

      assert.equal(await agent.ask('sí, confirmo'), 'Hecho.');
      assert.equal(asked.length, 1);
      assert.equal((await server.service.get({ merchantId: 'tienda_A' }, payment.id)).refundedMinor, 1000);
    });

    it('if the person says no, nothing is refunded and Claude is told why', async () => {
      const payment = await seed(5000);
      const claude = scriptedClaude(...refundTurns(payment.id));
      const agent = new PaymentsAgent({ messages: claude.api, mcp: await mcpAs('tienda-a-backend'), approve: async () => false });

      await agent.ask('reembolsa 1000');
      await agent.ask('sí');
      const [result] = lastToolResults(claude.requests[3]);
      assert.equal(result?.is_error, true);
      assert.match(String(result?.content), /declined/);
      assert.equal((await server.service.get({ merchantId: 'tienda_A' }, payment.id)).refundedMinor, 0);
    });

    it('without an approve callback, destructive calls are declined by default', async () => {
      const payment = await seed(5000);
      const turns = refundTurns(payment.id).slice(2);
      const claude = scriptedClaude(...turns);
      const agent = new PaymentsAgent({ messages: claude.api, mcp: await mcpAs('tienda-a-backend') });
      await agent.ask('confirmo');
      assert.equal(lastToolResults(claude.requests[1])[0]?.is_error, true);
    });
  });

  it('rejects a tool name that is not on the MCP server (the model cannot invent tools)', async () => {
    const claude = scriptedClaude(
      { stop: 'tool_use', content: [toolUse('x', 'refund_payment', { paymentId: 'p' })] },
      { stop: 'end_turn', content: [text('No puedo reembolsar.')] },
    );
    const agent = new PaymentsAgent({ messages: claude.api, mcp: await mcpAs('tienda-a-agent') });
    await agent.ask('reembolsa');
    const [result] = lastToolResults(claude.requests[1]);
    assert.equal(result?.is_error, true);
    assert.match(String(result?.content), /Unknown tool/);
  });
});

describe('PaymentsAgent loop edge cases', () => {
  const fakeMcp = (callTool: () => Promise<never> = async () => ({ content: [] }) as never) => ({
    listTools: async () => ({ tools: [{ name: 'get_payment', inputSchema: { type: 'object' as const } }] }) as never,
    callTool,
  });

  it('continues after pause_turn and stops at maxIterations', async () => {
    const claude = scriptedClaude(
      { stop: 'pause_turn', content: [] },
      { stop: 'tool_use', content: [toolUse('a', 'get_payment', {})] },
      { stop: 'tool_use', content: [toolUse('b', 'get_payment', {})] },
    );
    const agent = new PaymentsAgent({ messages: claude.api, mcp: fakeMcp(), maxIterations: 3 });
    assert.match(await agent.ask('x'), /Stopped after 3 steps/);
    assert.equal(claude.requests.length, 3);
  });

  it('reports refusals and truncated answers', async () => {
    const claude = scriptedClaude({ stop: 'refusal', content: [] }, { stop: 'max_tokens', content: [text('Parcial')] });
    const agent = new PaymentsAgent({ messages: claude.api, mcp: fakeMcp() });
    assert.equal(await agent.ask('a'), 'The model declined this request.');
    assert.equal(await agent.ask('b'), 'Parcial\n[answer truncated]');
  });

  it('turns an MCP transport failure into a tool error instead of crashing', async () => {
    const claude = scriptedClaude(
      { stop: 'tool_use', content: [toolUse('a', 'get_payment', {})] },
      { stop: 'end_turn', content: [text('El servidor no responde.')] },
    );
    const agent = new PaymentsAgent({
      messages: claude.api,
      mcp: fakeMcp(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    assert.equal(await agent.ask('x'), 'El servidor no responde.');
    const [result] = lastToolResults(claude.requests[1]);
    assert.equal(result?.is_error, true);
    assert.match(String(result?.content), /ECONNREFUSED/);
  });
});

describe('toToolResult', () => {
  it('serializes non-text MCP content and marks an empty result', () => {
    const image = toToolResult('a', { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] } as never);
    assert.match(String(image.content), /"type":"image"/);
    assert.equal(toToolResult('b', { content: [] } as never).content, '(empty result)');
  });
});
