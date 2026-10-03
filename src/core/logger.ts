import { pino, type Logger } from 'pino';

export type { Logger };

/** JSON to stdout: Promtail/Alloy ships it to Loki without parsing rules. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'payments-mcp' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: ['headers.authorization', 'headers.cookie'],
  });
}
