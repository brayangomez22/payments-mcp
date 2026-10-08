import type { CallToolResult } from '@modelcontextprotocol/server';
import { AppError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { Metrics, ToolOutcome } from '../core/metrics.js';

/** Success: a JSON text block for the model plus structuredContent for programmatic hosts. */
export function toolSuccess<T extends object>(data: T): CallToolResult & { structuredContent: T } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

/**
 * Runs a tool body and turns failures into `isError` results the model can act on.
 * Domain errors keep their code, message and details (e.g. remainingMinor) so the model can
 * self-correct. Anything else becomes a generic message: SQL errors or stack traces must never
 * reach the model (it may echo them to the user, or an attacker may be probing).
 */
export interface ToolContext {
  log: Logger;
  metrics?: Pick<Metrics, 'toolCall'> | undefined;
}

export async function runTool(
  { log, metrics }: ToolContext,
  tool: string,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const done = (outcome: ToolOutcome) => metrics?.toolCall(tool, outcome);
  try {
    const result = await body();
    log.info({ tool, outcome: 'ok' }, 'mcp tool call');
    done('ok');
    return result;
  } catch (err) {
    if (err instanceof AppError) {
      log.info({ tool, outcome: 'domain_error', code: err.code }, 'mcp tool call');
      done('domain_error');
      return toolError({ code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) });
    }
    log.error({ err, tool }, 'mcp tool call failed unexpectedly');
    done('internal_error');
    return toolError({ code: 'INTERNAL_ERROR', message: 'The payments service failed. Do not retry automatically.' });
  }
}

function toolError(error: { code: string; message: string; details?: unknown }): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
}
