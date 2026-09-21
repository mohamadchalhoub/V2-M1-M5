/**
 * §15.5 — Friday liquidation.
 *
 * The tests that matter most assert what liquidation must NOT do: touch a
 * position belonging to the deployment that is still trading, close anything
 * manual, or report flat on the strength of a request it merely sent.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateCompletion,
  nextAttempt,
  planLiquidation,
  type BrokerItem,
} from '../../src/xauusd-m1m5/liquidation';
import {
  V2_LIQUIDATION_ATTEMPT_TIMEOUT_SECONDS,
  V2_LIQUIDATION_MAX_ATTEMPTS,
  V2_MAGIC_M1,
  V2_MAGIC_M5,
} from '../../src/xauusd-m1m5/safety-constants';

const NOW = Date.UTC(2026, 8, 25, 20, 0, 0);

/** Magic numbers belonging to the M1 revision-5 bot that is still running. */
const RUNNING_BOT_M1 = 262610190;
const RUNNING_BOT_EXTREME = 262610191;
const LEGACY_GOLD = 262610181;

function item(over: Partial<BrokerItem> & { ticket: string }): BrokerItem {
  return { kind: 'POSITION', symbol: 'XAUUSD', magicNumber: null, volume: 0.5, ...over };
}

describe('§9.3 scope — only this application’s own exposure', () => {
  it('selects its own M1 and M5 positions', () => {
    const plan = planLiquidation([
      item({ ticket: '1', magicNumber: V2_MAGIC_M1 }),
      item({ ticket: '2', magicNumber: V2_MAGIC_M5 }),
    ]);
    expect(plan.targets.map((t) => t.timeframe).sort()).toEqual(['M1', 'M5']);
    expect(plan.excluded).toEqual([]);
  });

  it('never includes the running bot’s positions', () => {
    const plan = planLiquidation([
      item({ ticket: 'ours', magicNumber: V2_MAGIC_M1 }),
      item({ ticket: 'theirs-1', magicNumber: RUNNING_BOT_M1 }),
      item({ ticket: 'theirs-2', magicNumber: RUNNING_BOT_EXTREME }),
    ]);
    expect(plan.targets.map((t) => t.ticket)).toEqual(['ours']);
    expect(plan.excluded.map((e) => e.ticket).sort()).toEqual(['theirs-1', 'theirs-2']);
    for (const e of plan.excluded) {
      expect(e.reason).toMatch(/never closes, modifies, adopts or relabels/i);
    }
  });

  it('never includes legacy-deployment positions', () => {
    const plan = planLiquidation([item({ ticket: 'legacy', magicNumber: LEGACY_GOLD })]);
    expect(plan.targets).toEqual([]);
    expect(plan.excluded[0].reason).toMatch(/another trading application/i);
  });

  it('never includes manual positions with no magic number', () => {
    const plan = planLiquidation([item({ ticket: 'manual', magicNumber: null })]);
    expect(plan.targets).toEqual([]);
    expect(plan.excluded[0].reason).toMatch(/manual or unattributable/i);
  });

  it('never includes an unrecognised magic number', () => {
    const plan = planLiquidation([item({ ticket: 'stranger', magicNumber: 777777 })]);
    expect(plan.targets).toEqual([]);
  });

  it('leaves everything foreign alone even when nothing of ours is present', () => {
    const plan = planLiquidation([
      item({ ticket: 'a', magicNumber: RUNNING_BOT_M1 }),
      item({ ticket: 'b', magicNumber: null }),
      item({ ticket: 'c', magicNumber: LEGACY_GOLD }),
    ]);
    expect(plan.targets).toEqual([]);
    expect(plan.excluded).toHaveLength(3);
  });

  it('cancels pending orders before closing positions', () => {
    // A pending order that fills after the positions are closed would leave
    // exposure in an account the routine believes it has flattened.
    const plan = planLiquidation([
      item({ ticket: 'pos', magicNumber: V2_MAGIC_M1, kind: 'POSITION' }),
      item({ ticket: 'ord', magicNumber: V2_MAGIC_M5, kind: 'PENDING_ORDER' }),
    ]);
    expect(plan.targets.map((t) => t.kind)).toEqual(['PENDING_ORDER', 'POSITION']);
  });

  it('records the timeframe on every target, so M1 work never resolves to M5', () => {
    const plan = planLiquidation([
      item({ ticket: '1', magicNumber: V2_MAGIC_M1 }),
      item({ ticket: '2', magicNumber: V2_MAGIC_M5 }),
    ]);
    expect(plan.targets.find((t) => t.ticket === '1')?.timeframe).toBe('M1');
    expect(plan.targets.find((t) => t.ticket === '2')?.timeframe).toBe('M5');
  });
});

describe('§9.3 bounded retry', () => {
  it('sends the first attempt immediately', () => {
    expect(nextAttempt({ ticket: 't', attempts: 0, lastAttemptAtMs: null }, NOW).decision).toBe('SEND');
  });

  it('waits before repeating an unconfirmed request, to avoid a double close', () => {
    const r = nextAttempt({ ticket: 't', attempts: 1, lastAttemptAtMs: NOW - 5_000 }, NOW);
    expect(r.decision).toBe('WAIT');
    expect(r.detail).toMatch(/close the position twice/i);
  });

  it('retries once the attempt timeout has elapsed', () => {
    const r = nextAttempt(
      { ticket: 't', attempts: 1, lastAttemptAtMs: NOW - (V2_LIQUIDATION_ATTEMPT_TIMEOUT_SECONDS * 1000 + 1) },
      NOW,
    );
    expect(r.decision).toBe('SEND');
    expect(r.detail).toMatch(/attempt 2 of/);
  });

  it('escalates rather than retrying forever', () => {
    const r = nextAttempt({ ticket: 't', attempts: V2_LIQUIDATION_MAX_ATTEMPTS, lastAttemptAtMs: NOW - 60_000 }, NOW);
    expect(r.decision).toBe('ESCALATE');
    expect(r.detail).toMatch(/critical incident/i);
  });
});

describe('§9.3 completion is broker-confirmed, never inferred', () => {
  it('is not due before the cutoff', () => {
    const v = evaluateCompletion({ liquidationDue: false, deadlinePassed: false, brokerSnapshot: [] });
    expect(v.status).toBe('NOT_DUE');
  });

  it('confirms flat only from a broker snapshot showing no owned exposure', () => {
    const v = evaluateCompletion({ liquidationDue: true, deadlinePassed: false, brokerSnapshot: [] });
    expect(v.status).toBe('CONFIRMED_FLAT');
    expect(v.remainingOwned).toBe(0);
  });

  it('reports flat while foreign positions remain open, and says so', () => {
    const v = evaluateCompletion({
      liquidationDue: true,
      deadlinePassed: false,
      brokerSnapshot: [
        item({ ticket: 'theirs', magicNumber: RUNNING_BOT_M1 }),
        item({ ticket: 'manual', magicNumber: null }),
      ],
    });
    expect(v.status).toBe('CONFIRMED_FLAT');
    expect(v.detail).toMatch(/belonging to other applications are unaffected/i);
  });

  it('never reports flat when broker state could not be read', () => {
    const v = evaluateCompletion({ liquidationDue: true, deadlinePassed: false, brokerSnapshot: null });
    expect(v.status).toBe('IN_PROGRESS');
    expect(v.remainingOwned).toBe(-1);
    expect(v.detail).toMatch(/never reported as flat/i);
  });

  it('reports in progress while owned exposure remains', () => {
    const v = evaluateCompletion({
      liquidationDue: true,
      deadlinePassed: false,
      brokerSnapshot: [item({ ticket: 'ours', magicNumber: V2_MAGIC_M5 })],
    });
    expect(v.status).toBe('IN_PROGRESS');
    expect(v.remainingOwned).toBe(1);
  });

  it('reports a missed deadline with the exposure that remains', () => {
    const v = evaluateCompletion({
      liquidationDue: true,
      deadlinePassed: true,
      brokerSnapshot: [
        item({ ticket: 'ours-1', magicNumber: V2_MAGIC_M1 }),
        item({ ticket: 'theirs', magicNumber: RUNNING_BOT_M1 }),
      ],
    });
    expect(v.status).toBe('DEADLINE_MISSED');
    expect(v.remainingOwned).toBe(1);
    expect(v.detail).toMatch(/M1 POSITION ours-1/);
    expect(v.detail).not.toMatch(/theirs/);
    expect(v.detail).toMatch(/new entries stay blocked/i);
  });

  it('reports a missed deadline when broker state is unknown past 23:30', () => {
    const v = evaluateCompletion({ liquidationDue: true, deadlinePassed: true, brokerSnapshot: null });
    expect(v.status).toBe('DEADLINE_MISSED');
  });
});
