import type Anthropic from '@anthropic-ai/sdk';
import type { Client } from '@modelcontextprotocol/client';
import { isDestructive, toClaudeTool, toToolResult } from './mcp-bridge.js';

type McpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

/** The one Messages API call the agent needs. `anthropic.beta.messages` satisfies it; tests pass a fake. */
export interface MessagesApi {
  create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage>;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface PaymentsAgentDeps {
  messages: MessagesApi;
  mcp: Pick<Client, 'listTools' | 'callTool'>;
  model?: string;
  /** Host-side human approval for destructive calls. Without it, they are always declined. */
  approve?: (call: ToolCall) => Promise<boolean>;
  /** For the CLI to show what the agent is doing. */
  onToolCall?: (call: ToolCall) => void;
  /** Safety net: a confused model must not loop (and spend) forever. */
  maxIterations?: number;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM = `You are the payments assistant of one merchant. You act only through the payment tools; the
access token decides which merchant and which tools you have, so never ask the user for a merchant id.
Answer in the user's language, briefly. Amounts are integers in minor units (COP in whole pesos, USD in
cents): convert carefully and show them to the user in a readable format.
Before any refund, call refund_payment WITHOUT confirm, show the preview and wait for the user's
explicit approval in a later message. If a tool you would need is not available, say so plainly.`;

/**
 * A Claude agent whose tools come from an MCP server. One instance = one conversation.
 * The loop is the classic one: call Claude → run the tool_use blocks over MCP → send the results →
 * repeat until Claude answers without tools.
 */
export class PaymentsAgent {
  private readonly history: Anthropic.Beta.BetaMessageParam[] = [];
  private tools: { claude: Anthropic.Beta.BetaTool[]; byName: Map<string, McpTool> } | undefined;

  constructor(private readonly deps: PaymentsAgentDeps) {}

  /** What this token lets the agent do (tools/list is already filtered by scope on the server). */
  async toolNames(): Promise<string[]> {
    return (await this.loadTools()).claude.map((t) => t.name);
  }

  async ask(userText: string): Promise<string> {
    const { claude: tools, byName } = await this.loadTools();
    this.history.push({ role: 'user', content: userText });

    const maxIterations = this.deps.maxIterations ?? 10;
    for (let i = 0; i < maxIterations; i++) {
      const response = await this.deps.messages.create({
        model: this.deps.model ?? DEFAULT_MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools,
        messages: this.history,
        // Tool use over a handful of payment tools: medium effort is plenty (and Opus 5.5's default).
        output_config: { effort: 'medium' },
        // Same tools + system on every call: cache that prefix instead of paying for it each turn.
        cache_control: { type: 'ephemeral' },
        // If a safety classifier declines, the API retries on its recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      // The full content (thinking blocks included) goes back unchanged: the API requires it.
      this.history.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'refusal') return 'The model declined this request.';
      if (response.stop_reason === 'pause_turn') continue;
      if (response.stop_reason !== 'tool_use') {
        const text = textOf(response);
        return response.stop_reason === 'max_tokens' ? `${text}\n[answer truncated]` : text;
      }

      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      // Every result goes back in ONE user message, in the order Claude asked.
      const results = await Promise.all(calls.map((call) => this.runTool(call, byName)));
      this.history.push({ role: 'user', content: results });
    }
    return `Stopped after ${maxIterations} steps without a final answer.`;
  }

  private async runTool(
    call: Anthropic.Beta.BetaToolUseBlock,
    byName: Map<string, McpTool>,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    const tool = byName.get(call.name);
    if (!tool) return errorResult(call.id, `Unknown tool ${call.name}.`);
    this.deps.onToolCall?.({ name: call.name, input });

    // Second lock, on the host side: the server already requires confirm: true, but a person —
    // not the model — must be the one approving money going out.
    if (isDestructive(tool) && input['confirm'] === true) {
      const approved = (await this.deps.approve?.({ name: call.name, input })) ?? false;
      if (!approved) {
        return errorResult(call.id, 'The user declined this operation in the app. Do not retry unless they ask again.');
      }
    }

    try {
      return toToolResult(call.id, await this.deps.mcp.callTool({ name: call.name, arguments: input }));
    } catch (err) {
      // Transport failure (server down, token expired): tell Claude instead of crashing the conversation.
      return errorResult(call.id, `The payments server could not be reached: ${(err as Error).message}`);
    }
  }

  private async loadTools() {
    if (!this.tools) {
      const { tools } = await this.deps.mcp.listTools();
      this.tools = { claude: tools.map(toClaudeTool), byName: new Map(tools.map((t) => [t.name, t])) };
    }
    return this.tools;
  }
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function errorResult(toolUseId: string, message: string): Anthropic.Beta.BetaToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true };
}
