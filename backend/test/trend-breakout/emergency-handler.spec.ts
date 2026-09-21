import { describe, expect, it, vi } from 'vitest';
import { EmergencyHandlerPorts, handleMissingStopLoss } from '../../src/trend-breakout/emergency-handler';

// Every test in this file uses MOCKED broker ports only — per this task's
// explicit instruction to test emergency behavior with mocks, never a real
// broker connection.

function ports(overrides: Partial<EmergencyHandlerPorts> = {}): EmergencyHandlerPorts {
  return {
    getPositionState: vi.fn().mockResolvedValue({ ok: true, state: { exists: false, ticket: null, side: null, volume: null, stopLoss: null } }),
    setStopLoss: vi.fn().mockResolvedValue('OK'),
    closePosition: vi.fn().mockResolvedValue('CLOSED'),
    emitCriticalAlert: vi.fn().mockResolvedValue(undefined),
    persistIncident: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('handleMissingStopLoss', () => {
  it('MITIGATES when re-establishing the SL succeeds and is verified present', async () => {
    const p = ports({
      getPositionState: vi.fn().mockResolvedValue({ ok: true, state: { exists: true, ticket: 1, side: 'BUY', volume: 0.12, stopLoss: 1.0995 } }),
    });
    const outcome = await handleMissingStopLoss(1.0995, p);
    expect(outcome.status).toBe('MITIGATED');
    expect(outcome.blockEntries).toBe(true); // ALWAYS blocked, even on a clean mitigation (see module comment)
    expect(p.closePosition).not.toHaveBeenCalled(); // never closes when protection was successfully restored
    expect(p.persistIncident).toHaveBeenCalledWith(expect.objectContaining({ status: 'MITIGATED' }));
    expect(p.emitCriticalAlert).toHaveBeenCalledOnce();
  });

  it('MITIGATES (nothing to protect) when the position is already gone by the time it verifies', async () => {
    const p = ports(); // default getPositionState says exists: false
    const outcome = await handleMissingStopLoss(1.0995, p);
    expect(outcome.status).toBe('MITIGATED');
    expect(p.closePosition).not.toHaveBeenCalled();
  });

  it('closes the position when SL re-establishment does not stick, and MITIGATES once the close is verified', async () => {
    const p = ports({
      getPositionState: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, state: { exists: true, ticket: 42, side: 'BUY', volume: 0.12, stopLoss: null } }) // step 2: still no SL
        .mockResolvedValueOnce({ ok: true, state: { exists: false, ticket: null, side: null, volume: null, stopLoss: null } }), // post-close verify: gone
    });
    const outcome = await handleMissingStopLoss(1.0995, p);
    expect(p.closePosition).toHaveBeenCalledWith(42, 'BUY', 0.12); // closes BY TICKET — never an opposite opening order
    expect(outcome.status).toBe('MITIGATED');
  });

  it('never sends a close for an unidentified position (missing ticket/side/volume)', async () => {
    const p = ports({
      getPositionState: vi.fn().mockResolvedValue({ ok: true, state: { exists: true, ticket: null, side: null, volume: null, stopLoss: null } }),
    });
    const outcome = await handleMissingStopLoss(1.0995, p);
    expect(p.closePosition).not.toHaveBeenCalled();
    expect(outcome.status).toBe('UNRESOLVED');
  });

  it('stays UNRESOLVED, does not claim closed, and never retries when the close outcome is UNKNOWN', async () => {
    const p = ports({
      getPositionState: vi.fn().mockResolvedValue({ ok: true, state: { exists: true, ticket: 7, side: 'SELL', volume: 0.01, stopLoss: null } }),
      closePosition: vi.fn().mockResolvedValue('UNKNOWN'),
    });
    const outcome = await handleMissingStopLoss(2650, p);
    expect(outcome.status).toBe('UNRESOLVED');
    expect(outcome.blockEntries).toBe(true);
    expect(p.closePosition).toHaveBeenCalledTimes(1); // exactly once — no blind duplicate submission
  });

  it('stays UNRESOLVED when a position still exists after a reported-successful close', async () => {
    const p = ports({
      getPositionState: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, state: { exists: true, ticket: 7, side: 'SELL', volume: 0.01, stopLoss: null } })
        .mockResolvedValueOnce({ ok: true, state: { exists: true, ticket: 7, side: 'SELL', volume: 0.01, stopLoss: null } }), // still there!
      closePosition: vi.fn().mockResolvedValue('OK'),
    });
    const outcome = await handleMissingStopLoss(2650, p);
    expect(outcome.status).toBe('UNRESOLVED');
  });

  it('is UNRESOLVED, never crashes or infers state, when the verification query itself fails', async () => {
    const p = ports({ getPositionState: vi.fn().mockResolvedValue({ ok: false, reason: 'broker timeout' }) });
    const outcome = await handleMissingStopLoss(1.0995, p);
    expect(outcome.status).toBe('UNRESOLVED');
    expect(p.closePosition).not.toHaveBeenCalled();
  });

  it('always persists the incident and alerts, on every path', async () => {
    const p = ports({ getPositionState: vi.fn().mockResolvedValue({ ok: false, reason: 'x' }) });
    await handleMissingStopLoss(1.0995, p);
    expect(p.persistIncident).toHaveBeenCalledOnce();
    expect(p.emitCriticalAlert).toHaveBeenCalledOnce();
  });
});
