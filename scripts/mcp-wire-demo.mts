// Laboratorio: qué viaja por la red en MCP (Streamable HTTP). Sin SDK de cliente: fetch a mano.
//   npm run demo:mcp-wire
import type { AddressInfo } from 'node:net';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

// ── El SERVIDOR: declara qué sabe hacer ──
function buildServer(): McpServer {
  const server = new McpServer({ name: 'demo-pagos', version: '0.0.1' });
  server.registerTool(
    'get_exchange_rate',
    {
      description: 'Returns how many COP one unit of the given currency is worth.',
      inputSchema: toStandardJsonSchema(v.object({ currency: v.picklist(['USD', 'EUR']) })),
    },
    async ({ currency }) => ({
      content: [{ type: 'text', text: `1 ${currency} = ${currency === 'USD' ? 4100 : 4450} COP` }],
    }),
  );
  return server;
}

const app = createMcpExpressApp();
app.post('/mcp', async (req, res) => {
  // Stateless: a fresh server + transport per HTTP request.
  const server = buildServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
const http = app.listen(0);
await new Promise((r) => http.once('listening', r));
const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;

// ── El CLIENTE (lo que haría Claude Desktop, Claude Code o tu agente) ──
let id = 0;
async function send(title: string, method: string, params?: unknown, notification = false) {
  const message = { jsonrpc: '2.0', ...(notification ? {} : { id: ++id }), method, ...(params ? { params } : {}) };
  console.log(`\n━━━━━━━━ ${title} ━━━━━━━━`);
  console.log('>>> POST /mcp\n' + JSON.stringify(message, null, 2));
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  console.log(`<<< ${res.status}${text ? '\n' + JSON.stringify(JSON.parse(text), null, 2) : ' (sin cuerpo)'}`);
}

await send('1. initialize: el apretón de manos', 'initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'cliente-a-mano', version: '1.0' },
});
await send('2. notifications/initialized: "listo" (notificación, sin id)', 'notifications/initialized', undefined, true);
await send('3. tools/list: ¿qué sabes hacer?', 'tools/list');
await send('4. tools/call: ejecútalo', 'tools/call', { name: 'get_exchange_rate', arguments: { currency: 'USD' } });
await send('5. tools/call con argumentos inválidos', 'tools/call', { name: 'get_exchange_rate', arguments: { currency: 'JPY' } });
http.close();
