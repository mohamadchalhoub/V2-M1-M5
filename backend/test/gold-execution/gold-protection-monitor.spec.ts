import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GoldProtectionMonitorService } from '../../src/gold-execution/gold-protection-monitor.service';
import { IncomingPositionDto } from '../../src/collector-ingress/dto/snapshot.dto';
import { GOLD_MAGIC_NUMBER } from '../../src/gold-execution/gold-safety-constants';

const ACCOUNT_ID = 'acc-1';

function position(overrides: Partial<IncomingPositionDto> = {}): IncomingPositionDto {
  return {
    externalPositionId: 'pos-1',
    symbol: 'XAUUSD',
    side: 'BUY',
    volume: 0.01,
    openPrice: 2400,
    stopLoss: 2390,
    takeProfit: 2420,
    profit: 1.5,
    swap: 0,
    openedAt: '2026-09-15T10:00:00.000Z',
    raw: { magic: GOLD_MAGIC_NUMBER },
    ...overrides,
  } as IncomingPositionDto;
}

describe('GoldProtectionMonitorService — one restore attempt, then reconciliation, then close if still unprotected', () => {
  let prismaMock: any;
  let telegramMock: any;
  let goldAiSummaryMock: any;
  let protectionRestoreMock: any;
  let closeExecutionMock: any;
  let service: GoldProtectionMonitorService;

  beforeEach(() => {
    prismaMock = { goldTelegramNotification: { findFirst: vi.fn().mockResolvedValue(null) } };
    telegramMock = { notify: vi.fn().mockResolvedValue(undefined) };
    goldAiSummaryMock = { generateForEvent: vi.fn().mockResolvedValue(undefined) };
    protectionRestoreMock = { requestRestore: vi.fn().mockResolvedValue({ id: 'restore-req-1' }) };
    closeExecutionMock = { requestClose: vi.fn().mockResolvedValue({ request: { id: 'close-req-1', status: 'PENDING' }, duplicate: false }) };
    service = new GoldProtectionMonitorService(prismaMock, telegramMock, goldAiSummaryMock, protectionRestoreMock, closeExecutionMock);
  });

  it('ignores non-gold symbols entirely', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ symbol: 'EURUSD', stopLoss: undefined, takeProfit: undefined })]);
    expect(telegramMock.notify).not.toHaveBeenCalled();
    expect(protectionRestoreMock.requestRestore).not.toHaveBeenCalled();
    expect(closeExecutionMock.requestClose).not.toHaveBeenCalled();
  });

  it('a fully protected position never alerts or remediates', async () => {
    await service.checkPositions(ACCOUNT_ID, [position()]);
    expect(telegramMock.notify).not.toHaveBeenCalled();
    expect(protectionRestoreMock.requestRestore).not.toHaveBeenCalled();
  });

  it('cycle 1 — new incident: alerts MISSING_PROTECTION and queues exactly ONE restore attempt', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    const eventTypes = telegramMock.notify.mock.calls.map((c: any[]) => c[0]);
    expect(eventTypes).toContain('MISSING_PROTECTION');
    expect(eventTypes).toContain('PROTECTION_RESTORE_REQUESTED');
    expect(protectionRestoreMock.requestRestore).toHaveBeenCalledTimes(1);
    // `protectionUsd` is asserted explicitly, not loosely: after the strategy
    // migration this monitor serves two owners, and a position opened by the
    // RETIRED H4 strategy must keep being restored at ITS OWN $10 distance —
    // never re-protected at the active RSI strategy's $5. The test position's
    // magic is the retired strategy's, so $10 is the correct expectation, and
    // a regression that applied the new distance to an old position would
    // fail here rather than silently change a live position's stop.
    expect(protectionRestoreMock.requestRestore).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID, positionTicket: 'pos-1', side: 'BUY', entryPrice: 2400, goldPointSize: expect.any(Number),
      protectionUsd: 10,
    });
    expect(closeExecutionMock.requestClose).not.toHaveBeenCalled();
  });

  it('single-attempt-succeeds: cycle 2 shows the position actually protected (reconciled) -> PROTECTION_RESTORED, never closes', async () => {
    prismaMock.goldTelegramNotification.findFirst.mockResolvedValueOnce({ eventType: 'PROTECTION_RESTORE_REQUESTED' });
    await service.checkPositions(ACCOUNT_ID, [position()]); // now protected
    expect(telegramMock.notify).toHaveBeenCalledTimes(1);
    expect(telegramMock.notify.mock.calls[0][0]).toBe('PROTECTION_RESTORED');
    expect(closeExecutionMock.requestClose).not.toHaveBeenCalled();
    expect(protectionRestoreMock.requestRestore).not.toHaveBeenCalled();
  });

  it('single-attempt-fails-then-reconciliation-confirms-unprotected-so-closes: cycle 2 STILL shows unprotected -> closes, no second restore attempt', async () => {
    prismaMock.goldTelegramNotification.findFirst.mockResolvedValueOnce({ eventType: 'PROTECTION_RESTORE_REQUESTED' });
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]); // still unprotected
    const eventTypes = telegramMock.notify.mock.calls.map((c: any[]) => c[0]);
    expect(eventTypes).toContain('PROTECTION_REMEDIATION_CLOSE_REQUESTED');
    expect(protectionRestoreMock.requestRestore).not.toHaveBeenCalled(); // no second attempt
    expect(closeExecutionMock.requestClose).toHaveBeenCalledWith({ accountId: ACCOUNT_ID, positionTicket: 'pos-1', side: 'BUY', volume: 0.01 });
  });

  it('ambiguous-response-triggers-reconciliation-not-blind-retry: reconciliation decision is made purely from real position data, never from the collector\'s modify-response, which this service never even sees', async () => {
    // This test documents the actual design: GoldProtectionMonitorService's
    // decision to close is driven ENTIRELY by `isProtected` (computed from
    // the position's real broker-reported stopLoss/takeProfit on this
    // snapshot) plus `lastEventType` — it has no branch anywhere on what the
    // collector's own restore-attempt response said (that response is
    // recorded separately, informationally, by
    // GoldExecutionController.postRestoreProtectionResult, and never
    // consulted here). So whether the broker's original modify response was
    // ok:true, ok:false, or anything in between, an "ambiguous" outcome is
    // handled identically: by trusting only the NEXT real snapshot.
    prismaMock.goldTelegramNotification.findFirst.mockResolvedValueOnce({ eventType: 'PROTECTION_RESTORE_REQUESTED' });
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    expect(protectionRestoreMock.requestRestore).not.toHaveBeenCalled();
    expect(closeExecutionMock.requestClose).toHaveBeenCalledTimes(1);
  });

  it('MT5 convention: stopLoss/takeProfit of 0 also counts as unprotected', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: 0, takeProfit: 0 })]);
    expect(telegramMock.notify.mock.calls.map((c: any[]) => c[0])).toContain('MISSING_PROTECTION');
    expect(protectionRestoreMock.requestRestore).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-alert or re-request restore on repeated cycles while state is unchanged (transition-only)', async () => {
    prismaMock.goldTelegramNotification.findFirst.mockResolvedValueOnce(null);
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    expect(protectionRestoreMock.requestRestore).toHaveBeenCalledTimes(1);

    // Cycle 2 also shows RESTORE_REQUESTED as last state AND still
    // unprotected -> this now triggers the close (not a no-op) per the
    // corrected policy — verified by the dedicated test above. This test
    // instead checks a genuinely-idle repeat: already closing.
    prismaMock.goldTelegramNotification.findFirst.mockResolvedValueOnce({ eventType: 'PROTECTION_REMEDIATION_CLOSE_REQUESTED' });
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    expect(protectionRestoreMock.requestRestore).toHaveBeenCalledTimes(1); // still just the one
    expect(closeExecutionMock.requestClose).not.toHaveBeenCalled(); // no re-close while one is already in flight
  });

  it('a repeat incident after a full restoration alerts and requests restore again (fresh, non-colliding dedup key)', async () => {
    prismaMock.goldTelegramNotification.findFirst.mockResolvedValueOnce({ eventType: 'PROTECTION_RESTORED' });
    await service.checkPositions(ACCOUNT_ID, [position({ takeProfit: undefined })]);
    expect(telegramMock.notify.mock.calls.map((c: any[]) => c[0])).toContain('MISSING_PROTECTION');
    expect(protectionRestoreMock.requestRestore).toHaveBeenCalledTimes(1);
  });

  it('dedup key for the alert is scoped per-position and includes a fresh timestamp per incident', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    const dedupKey = telegramMock.notify.mock.calls[0][1];
    expect(dedupKey).toMatch(/^protection:pos-1:missing:\d+$/);
  });

  it('if queuing the restore request itself fails, alerts a CRITICAL PROTECTION_REMEDIATION_FAILED — never fails silently', async () => {
    protectionRestoreMock.requestRestore.mockRejectedValueOnce(new Error('db down'));
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    const eventTypes = telegramMock.notify.mock.calls.map((c: any[]) => c[0]);
    expect(eventTypes).toContain('PROTECTION_REMEDIATION_FAILED');
  });

  it('if queuing the fallback close itself fails, alerts a CRITICAL PROTECTION_REMEDIATION_FAILED', async () => {
    prismaMock.goldTelegramNotification.findFirst.mockResolvedValueOnce({ eventType: 'PROTECTION_RESTORE_REQUESTED' });
    closeExecutionMock.requestClose.mockRejectedValueOnce(new Error('db down'));
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined })]);
    const eventTypes = telegramMock.notify.mock.calls.map((c: any[]) => c[0]);
    expect(eventTypes).toContain('PROTECTION_REMEDIATION_FAILED');
  });

  it('task item 4 — alerts on an unprotected position with a DIFFERENT magic (not ours), but does NOT auto-remediate it', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined, raw: { magic: 999999999 } })]);
    expect(telegramMock.notify.mock.calls.map((c: any[]) => c[0])).toContain('MISSING_PROTECTION');
    expect(protectionRestoreMock.requestRestore).not.toHaveBeenCalled();
  });

  it('task item 4 — alerts on an unprotected position with NO magic at all (manual trade), but does NOT auto-remediate it', async () => {
    await service.checkPositions(ACCOUNT_ID, [position({ stopLoss: undefined, raw: {} })]);
    expect(telegramMock.notify.mock.calls.map((c: any[]) => c[0])).toContain('MISSING_PROTECTION');
    expect(protectionRestoreMock.requestRestore).not.toHaveBeenCalled();
  });

  it('one position failing does not stop the others in the same batch', async () => {
    prismaMock.goldTelegramNotification.findFirst
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(null);
    await service.checkPositions(ACCOUNT_ID, [
      position({ externalPositionId: 'pos-fail', stopLoss: undefined }),
      position({ externalPositionId: 'pos-ok', stopLoss: undefined }),
    ]);
    const missingCalls = telegramMock.notify.mock.calls.filter((c: any[]) => c[0] === 'MISSING_PROTECTION');
    expect(missingCalls).toHaveLength(1);
    expect(missingCalls[0][1]).toContain('pos-ok');
  });
});
