/**
 * The production `TelegramBrokerPort`: hand the leg to the collector's queue.
 *
 * As with Engine A, this looks like it does nothing, and that is the point.
 * By the time `submit` is called the leg row is already durably `PENDING`,
 * and that row IS the queue — the collector polls for PENDING legs and claims
 * them. What this port contributes is the ANSWER: `QUEUED`, meaning "handed
 * off, outcome not yet known", which is deliberately distinct from `UNKNOWN`,
 * meaning "we tried to reach the broker and cannot say what happened".
 *
 * Conflating the two would either flag a healthy hand-off as an anomaly
 * needing reconciliation, or overwrite the `PENDING` status the collector's
 * poll depends on and lose the order entirely.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { TelegramBrokerPort, TelegramSubmitRequest, TelegramSubmitResponse } from './execution.service';

@Injectable()
export class TelegramQueueingBrokerPort implements TelegramBrokerPort {
  private readonly logger = new Logger(TelegramQueueingBrokerPort.name);

  async submit(request: TelegramSubmitRequest): Promise<TelegramSubmitResponse> {
    this.logger.log(
      `queued telegram leg ${request.legIndex} ${request.direction} ${request.volumeLots} lots ` +
        `sl=${request.stopLoss} tp=${request.takeProfit} magic=${request.magicNumber} signal=${request.signalId}`,
    );
    return { status: 'QUEUED' };
  }
}
