/**
 * The production `BrokerPort`: hand the order to the collector's queue.
 *
 * This looks like it does nothing, and that is the point worth explaining.
 *
 * By the time `submit` is called, `M1M5ExecutionService` has already marked
 * the decision row `PENDING` and durably held the timeframe's slot. That row
 * IS the queue — the collector polls for `PENDING` rows and claims them. So
 * enqueueing has already happened as part of the same durable step that makes
 * a crash recoverable, and there is nothing left for this port to write.
 *
 * What it contributes is the ANSWER: `QUEUED`, meaning "handed off, outcome
 * not yet known". That is distinct from `UNKNOWN`, which means "we tried to
 * reach the broker and cannot say what happened". Conflating them would either
 * mark a perfectly healthy hand-off as an anomaly needing reconciliation, or
 * overwrite the `PENDING` status the collector's poll depends on and lose the
 * order entirely.
 *
 * The port still exists as an interface because the execution service must be
 * testable against a simulated broker that answers FILLED, FAILED and UNKNOWN
 * synchronously. Production simply has no synchronous broker to answer with —
 * the terminal lives in another container, behind a poll.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { BrokerPort, SubmitRequest, SubmitResponse } from './execution.service';

@Injectable()
export class M1M5QueueingBrokerPort implements BrokerPort {
  private readonly logger = new Logger(M1M5QueueingBrokerPort.name);

  async submit(request: SubmitRequest): Promise<SubmitResponse> {
    this.logger.log(
      `queued ${request.timeframe} ${request.direction} ${request.volumeLots} lots ` +
        `entry=${request.entryPrice} sl=${request.stopLoss} tp=${request.takeProfit} ` +
        `magic=${request.magicNumber} decision=${request.decisionId}`,
    );
    return { status: 'QUEUED' };
  }
}
