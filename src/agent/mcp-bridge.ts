import type Anthropic from '@anthropic-ai/sdk';
import type { Client } from '@modelcontextprotocol/client';

type McpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
type McpCallResult = Awaited<ReturnType<Client['callTool']>>;

/**
 * MCP tool → Claude tool. Same name, description and JSON Schema: the MCP server is the single
 * source of truth, so the agent never hardcodes what the payment tools are.
 */
export function toClaudeTool(tool: McpTool): Anthropic.Beta.BetaTool {
  return {
    name: tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  };
}

/** MCP tool result → Claude tool_result. isError travels as is_error so Claude can self-correct. */
export function toToolResult(toolUseId: string, result: McpCallResult): Anthropic.Beta.BetaToolResultBlockParam {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .map((b) => (b.type === 'text' ? b.text : JSON.stringify(b)))
    .join('\n');
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: text || '(empty result)',
    ...(result.isError === true ? { is_error: true } : {}),
  };
}

/** Tools that MCP marks as destructive (refund_payment): the host asks the human before running them. */
export function isDestructive(tool: McpTool): boolean {
  return tool.annotations?.destructiveHint === true;
}
