import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../logger.js';

const REQUEST_ID = /^[\w-]{1,64}$/;

/** Propagates (or creates) X-Request-Id and logs one line per request with its latency. */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.log = logger.child({ requestId: req.requestId });
    res.setHeader('x-request-id', req.requestId);

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      req.log.info(
        { method: req.method, path: req.originalUrl, status: res.statusCode, durationMs },
        'request completed',
      );
    });
    next();
  };
}
