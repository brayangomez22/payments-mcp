import type { Logger } from '../logger.js';
import type { DrainResult, EventPublisher, OutboxStore } from './outbox.js';

/** SendMessageBatch accepts at most 10 entries. */
export const SQS_MAX_BATCH = 10;

export interface OutboxRelayDeps {
  store: OutboxStore;
  publisher: EventPublisher;
  logger: Logger;
  intervalMs: number;
  batchSize?: number;
}

/** Polls the outbox and forwards pending events to the publisher. Failures are retried, never lost. */
export class OutboxRelay {
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | undefined;
  private pass: Promise<void> | undefined;
  private stopped = true;

  constructor(private readonly deps: OutboxRelayDeps) {
    this.batchSize = Math.min(deps.batchSize ?? SQS_MAX_BATCH, SQS_MAX_BATCH);
  }

  /** One pass over the outbox. Throws if the database or the broker fails. */
  async runOnce(): Promise<DrainResult> {
    const result = await this.deps.store.drain(this.batchSize, (events) => this.deps.publisher.publish(events));
    if (result.published < result.claimed) {
      this.deps.logger.warn(result, 'some outbox events were not accepted by the broker; they will be retried');
    }
    return result;
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops polling and waits for the pass in flight, so shutdown does not cut a transaction. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pass;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.pass = this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    let backlog = false;
    try {
      // A full batch that all went through probably means more are waiting: go again right away.
      // Partial or failed batches wait the interval, so a broken broker is not hammered.
      backlog = (await this.runOnce()).published === this.batchSize;
    } catch (err) {
      this.deps.logger.error({ err }, 'outbox relay pass failed');
    }
    this.schedule(backlog ? 0 : this.deps.intervalMs);
  }
}
