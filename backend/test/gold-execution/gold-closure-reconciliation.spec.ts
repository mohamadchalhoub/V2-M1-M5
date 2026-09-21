import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GoldClosureReconciliationService } from '../../src/gold-execution/gold-closure-reconciliation.service';
import { IncomingDealDto } from '../../src/collector-ingress/dto/trades.dto';
import { GOLD_MAGIC_NUMBER } from '../../src/gold-execution/gold-safety-constants';

function deal(overrides: Partial<IncomingDealDto> = {}): IncomingDealDto {
  return {
    externalTradeId: 'ticket-1',
    positionId: 'pos-1',
    symbol: 'XAUUSD',
    side: 'BUY',
    dealEntry: 'OUT',
    volume: 0.01,
    price: 2400,
    commission: -1,
    swap: -0.5,
    profit: 12.34,
    executedAt: '2026-09-15T10:00:00.000Z',
    raw: { magic: GOLD_MAGIC_NUMBER },
    ...overrides,
  } as IncomingDealDto;
}

describe('GoldClosureReconciliationService', () => {
  let prismaMock: any;
  let telegramMock: any;
  let goldAiSummaryMock: any;
  let service: GoldClosureReconciliationService;

  beforeEach(() => {
    prismaMock = { position: { findUnique: vi.fn() }, trade: { findMany: vi.fn().mockResolvedValue([]) } };
    telegramMock = { notify: vi.fn().mockResolvedValue(undefined) };
    goldAiSummaryMock = { generateForEvent: vi.fn().mockResolvedValue(undefined) };
    service = new GoldClosureReconciliationService(prismaMock, telegramMock, goldAiSummaryMock);
  });

  it('ignores non-gold symbols entirely', async () => {
    await service.reconcile('acc-1', 'MT5' as any, [deal({ symbol: 'EURUSD' })]);
    expect(telegramMock.notify).not.toHaveBeenCalled();
  });

  it('ignores IN deals (position opens, not closures)', async () => {
    await service.reconcile('acc-1', 'MT5' as any, [deal({ dealEntry: 'IN' })]);
    expect(telegramMock.notify).not.toHaveBeenCalled();
  });

  it('a FULL close (position no longer OPEN) sends a FULL_CLOSE notification keyed by deal ticket', async () => {
    prismaMock.position.findUnique.mockResolvedValue({ status: 'CLOSED' });
    await service.reconcile('acc-1', 'MT5' as any, [deal()]);

    expect(telegramMock.notify).toHaveBeenCalledTimes(1);
    const [eventType, dedupKey, text] = telegramMock.notify.mock.calls[0];
    expect(eventType).toBe('FULL_CLOSE');
    expect(dedupKey).toBe('closure:ticket-1');
    expect(text).toContain('thisDealNetPnl=10.84'); // 12.34 - 1 - 0.5

    // Fire-and-forget AI summary call, same event/text, never blocking the Telegram send above.
    expect(goldAiSummaryMock.generateForEvent).toHaveBeenCalledWith('FULL_CLOSE', '2026-09-15T10:00:00.000Z', text);
  });

  it('a PARTIAL close (position still OPEN) sends a PARTIAL_CLOSE notification, distinct event type', async () => {
    prismaMock.position.findUnique.mockResolvedValue({ status: 'OPEN' });
    await service.reconcile('acc-1', 'MT5' as any, [deal()]);

    const [eventType] = telegramMock.notify.mock.calls[0];
    expect(eventType).toBe('PARTIAL_CLOSE');
  });

  it('treats a missing Position row as a full close (fail-open to "full" rather than guessing partial)', async () => {
    prismaMock.position.findUnique.mockResolvedValue(null);
    await service.reconcile('acc-1', 'MT5' as any, [deal({ positionId: undefined })]);

    const [eventType] = telegramMock.notify.mock.calls[0];
    expect(eventType).toBe('FULL_CLOSE');
  });

  it('OUT_BY and INOUT deal entries are also treated as closures', async () => {
    prismaMock.position.findUnique.mockResolvedValue({ status: 'CLOSED' });
    await service.reconcile('acc-1', 'MT5' as any, [deal({ dealEntry: 'OUT_BY', externalTradeId: 't2' }), deal({ dealEntry: 'INOUT', externalTradeId: 't3' })]);
    expect(telegramMock.notify).toHaveBeenCalledTimes(2);
  });

  it('dedup key is derived only from the deal ticket, so re-processing the same deal produces the same key (idempotent at the notify layer)', async () => {
    prismaMock.position.findUnique.mockResolvedValue({ status: 'CLOSED' });
    await service.reconcile('acc-1', 'MT5' as any, [deal()]);
    await service.reconcile('acc-1', 'MT5' as any, [deal()]); // simulate the collector re-sending an overlapping window
    const keys = telegramMock.notify.mock.calls.map((c: any[]) => c[1]);
    expect(keys[0]).toBe(keys[1]);
  });

  it('task item 4 — a deal with a DIFFERENT magic (not this strategy) is never treated as this strategy\'s closure', async () => {
    prismaMock.position.findUnique.mockResolvedValue({ status: 'CLOSED' });
    await service.reconcile('acc-1', 'MT5' as any, [deal({ raw: { magic: 999999999 } })]);
    expect(telegramMock.notify).not.toHaveBeenCalled();
  });

  it('task item 4 — a deal with NO magic at all (manual trade) is never treated as this strategy\'s closure', async () => {
    prismaMock.position.findUnique.mockResolvedValue({ status: 'CLOSED' });
    await service.reconcile('acc-1', 'MT5' as any, [deal({ raw: {} })]);
    expect(telegramMock.notify).not.toHaveBeenCalled();
  });

  it('task item 4 — reports both per-deal net P&L and total position net P&L (incl. entry-side commission)', async () => {
    prismaMock.position.findUnique.mockResolvedValue({ status: 'CLOSED' });
    // Entry deal (IN) with its own commission, plus this closing deal.
    prismaMock.trade.findMany.mockResolvedValue([
      { profit: { toNumber: () => 0 }, commission: { toNumber: () => -2 }, swap: { toNumber: () => 0 } }, // entry deal: -$2 commission
      { profit: { toNumber: () => 12.34 }, commission: { toNumber: () => -1 }, swap: { toNumber: () => -0.5 } }, // this closing deal
    ]);
    await service.reconcile('acc-1', 'MT5' as any, [deal()]);
    const text = telegramMock.notify.mock.calls[0][2];
    expect(text).toContain('thisDealNetPnl=10.84'); // 12.34 - 1 - 0.5, this deal only
    expect(text).toContain('positionNetPnlSoFar=8.84'); // 10.84 + (-2) entry commission
  });

  it('one deal failing to reconcile does not stop the others in the same batch', async () => {
    prismaMock.position.findUnique
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ status: 'CLOSED' });
    await service.reconcile('acc-1', 'MT5' as any, [deal({ externalTradeId: 't-fail' }), deal({ externalTradeId: 't-ok' })]);
    expect(telegramMock.notify).toHaveBeenCalledTimes(1);
    expect(telegramMock.notify.mock.calls[0][1]).toBe('closure:t-ok');
  });
});
