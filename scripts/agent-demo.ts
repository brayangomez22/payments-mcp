// A Claude agent that uses this project's MCP server. Usage:
//   npm run dev                                   (in another terminal: the payments server)
//   npm run demo:agent                            (interactive chat)
//   npm run demo:agent -- "¿Cuáles fueron mis últimos 3 pagos?"   (one question and exit)
//
// Needs Anthropic credentials (ANTHROPIC_API_KEY or an `ant auth login` profile).
import { createInterface } from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import { Client, ClientCredentialsProvider, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PaymentsAgent } from '../src/agent/payments-agent.js';

const mcpUrl = new URL(process.env['PAYMENTS_MCP_URL'] ?? 'http://localhost:3000/mcp');
// Dev credentials from client-registry.ts. tienda-a-agent can read and charge, NOT refund:
// use tienda-a-backend to see the refund flow with its two approvals.
const clientId = process.env['AGENT_CLIENT_ID'] ?? 'tienda-a-agent';
const clientSecret = process.env['AGENT_CLIENT_SECRET'] ?? 'dev-secret-agent-a';

// Only the URL and the credentials: the SDK gets a 401, reads the Protected Resource Metadata, finds
// the authorization server and requests the token by itself (the MCP authorization spec).
const mcp = new Client({ name: 'payments-agent-demo', version: '1.0.0' });
await mcp.connect(
  new StreamableHTTPClientTransport(mcpUrl, {
    authProvider: new ClientCredentialsProvider({
      clientId,
      clientSecret,
      // Our secret only goes to OUR authorization server, whatever the resource metadata claims.
      expectedIssuer: process.env['AGENT_EXPECTED_ISSUER'] ?? mcpUrl.origin,
    }),
  }),
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const agent = new PaymentsAgent({
  messages: new Anthropic().beta.messages,
  mcp,
  ...(process.env['AGENT_MODEL'] ? { model: process.env['AGENT_MODEL'] } : {}),
  onToolCall: ({ name, input }) => console.log(`  🔧 ${name} ${JSON.stringify(input)}`),
  approve: async ({ name, input }) => {
    const answer = await rl.question(`  ⚠️  ${name} ${JSON.stringify(input)}\n  ¿Apruebas esta operación? (s/n) `);
    return /^s(i|í)?$/i.test(answer.trim());
  },
});

console.log(`Conectado a ${mcpUrl.href} como ${clientId}. Tools: ${(await agent.toolNames()).join(', ')}`);

const oneShot = process.argv.slice(2).join(' ').trim();
try {
  if (oneShot) {
    console.log(await agent.ask(oneShot));
  } else {
    console.log('Escribe tu pregunta (vacío para salir).');
    for (;;) {
      const question = (await rl.question('\ntú> ')).trim();
      if (!question) break;
      console.log(`\nagente> ${await agent.ask(question)}`);
    }
  }
} finally {
  rl.close();
  await mcp.close();
}
