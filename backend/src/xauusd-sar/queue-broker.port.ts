/**
 * The production `SarBrokerPort`: hand the order to the collector's queue.
 *
 * By the time `submit` is called, `SarExecutionService` has already written
 * the `XauusdSarOrderAttempt` row `PENDING` — that row IS the queue, the
 * collector polls for it. Mirrors `xauusd-m1m5/queue-broker.port.ts` exactly,
 * for the identical reason: there is nothing left for this port to persist,
 * only the QUEUED answer to give back.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { SarBrokerPort, SarSubmitRequest, SarSubmitResponse } from './execution.service';

@Injectable()
export class SarQueueingBrokerPort implements SarBrokerPort {
  private readonly logger = new Logger(SarQueueingBrokerPort.name);

  async submit(request: SarSubmitRequest): Promise<SarSubmitResponse> {
    this.logger.log(
      `queued ${request.kind} ${request.direction} ${request.volumeLots} lots magic=${request.magicNumber} ` +
        `tag=${request.idempotencyTag}` + (request.closingTicket ? ` closing=${request.closingTicket}` : ''),
    );
    return { status: 'QUEUED' };
  }
}
