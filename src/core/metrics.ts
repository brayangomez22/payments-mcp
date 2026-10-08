import type { Request, RequestHandler, Response } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Mount before a router mounted under a prefix. When a handler throws, Express restores
 * req.baseUrl on the way to the error handler, so by 'finish' the prefix would be gone.
 */
export const rememberMountPath: RequestHandler = (req, res, next) => {
  res.locals['mountPath'] = req.baseUrl;
  next();
};

function routeLabel(req: Request, res: Response): string {
  const mount = typeof res.locals['mountPath'] === 'string' ? res.locals['mountPath'] : req.baseUrl;
  // req.route only exists once a route matched. Express paths can be arrays: use the first.
  if (req.route) return mount + String([req.route.path].flat()[0]);
  // Rejected before reaching a route (e.g. 401 from authenticate): group by mount, never by URL.
  return mount ? `${mount}/*` : 'unmatched';
}

export type ToolOutcome = 'ok' | 'domain_error' | 'internal_error';

/**
 * Every metric of the service, on its own registry (tests get a fresh one each time).
 * Labels only take values from small, fixed sets: a route pattern, never a URL with ids.
 */
export class Metrics {
  readonly registry = new Registry();

  private readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency. Its _count series is the request counter.',
    labelNames: ['method', 'route', 'status_code'],
    // Payments are mostly a few ms plus the provider call (timeout 5 s): finer buckets at the low end.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly payments = new Counter({
    name: 'payments_total',
    help: 'Payment status transitions, by the status the payment moved to.',
    labelNames: ['status'],
    registers: [this.registry],
  });

  private readonly toolCalls = new Counter({
    name: 'mcp_tool_calls_total',
    help: 'MCP tool invocations by tool and outcome.',
    labelNames: ['tool', 'outcome'],
    registers: [this.registry],
  });

  private readonly outboxPublished = new Counter({
    name: 'outbox_events_published_total',
    help: 'Outbox events accepted by the broker.',
    registers: [this.registry],
  });

  private readonly outboxErrors = new Counter({
    name: 'outbox_relay_errors_total',
    help: 'Relay passes that failed (database or broker unreachable).',
    registers: [this.registry],
  });

  constructor(options: { defaultMetrics?: boolean } = {}) {
    // CPU, memory, event loop lag, GC: the "is the process healthy" basics.
    if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry });
  }

  paymentStatus(status: string): void {
    this.payments.inc({ status });
  }

  toolCall(tool: string, outcome: ToolOutcome): void {
    this.toolCalls.inc({ tool, outcome });
  }

  eventsPublished(count: number): void {
    this.outboxPublished.inc(count);
  }

  relayError(): void {
    this.outboxErrors.inc();
  }

  /** Pending outbox rows, read on every scrape. A growing value means events are stuck. */
  trackOutboxBacklog(countPending: () => Promise<number>): void {
    new Gauge({
      name: 'outbox_pending_events',
      help: 'Outbox events not yet published.',
      registers: [this.registry],
      async collect() {
        this.set(await countPending());
      },
    });
  }

  /** Times every request and labels it with the matched route pattern. */
  httpMiddleware(): RequestHandler {
    return (req, res, next) => {
      const end = this.httpDuration.startTimer({ method: req.method });
      res.on('finish', () => {
        end({ route: routeLabel(req, res), status_code: res.statusCode });
      });
      next();
    };
  }
}
