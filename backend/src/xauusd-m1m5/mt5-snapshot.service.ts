/**
 * The MT5 permission snapshot: the only evidence the execution path accepts
 * that the terminal may actually place an order (§9.5).
 *
 * ## Why this exists at all
 *
 * Fresh quotes are not permission to trade. A terminal with algorithmic
 * trading switched off, or logged into the wrong account, or disconnected from
 * the trade server, streams perfectly good prices right up to the moment an
 * order is rejected. Price flow and trade permission are independent, and
 * inferring one from the other is how a strategy discovers it cannot trade at
 * the worst possible moment.
 *
 * So the collector reads the permissions from the live terminal and reports
 * them here, and `evaluateReadiness` refuses to submit without a recent one.
 *
 * ## Three states, not two
 *
 * Every permission is `boolean | null`, and null means "the collector could
 * not read this". That third state is load-bearing. Collapsing it into `true`
 * would let a missing answer look like a granted permission; collapsing it
 * into `false` would disguise a genuine fault as an ordinary refusal and send
 * an operator looking in the wrong place. Null is carried all the way through
 * and treated as a blocker.
 *
 * ## One row, overwritten
 *
 * This is current state, not a history, so there is one row per account. That
 * makes staleness the thing to guard: a row that is never replaced looks
 * exactly like a row that was replaced a second ago, and a disconnected
 * terminal's last good snapshot would otherwise read as permission. The row
 * therefore records when the COLLECTOR captured the values rather than when
 * the row was written, and the readiness check measures age from that.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Mt5PermissionSnapshot } from './mt5-readiness';

/** What the collector reports. Every permission may be absent. */
export interface Mt5SnapshotInput {
  readonly capturedAtMs: number;
  readonly loginId: string | null;
  readonly server: string | null;
  readonly tradeMode: string | null;
  readonly marginMode: string | null;
  readonly terminalConnected: boolean | null;
  readonly terminalTradeAllowed: boolean | null;
  readonly terminalTradeApiDisabled: boolean | null;
  readonly accountTradeAllowed: boolean | null;
  readonly accountTradeExpert: boolean | null;
  readonly sessionOpen: boolean | null;
  readonly leverage: number | null;
}

/**
 * What the execution path reads back.
 *
 * `sessionOpen` is kept OUTSIDE the permission snapshot rather than added to
 * it, because the two answer different questions and are consumed by different
 * gates. The permissions answer "is this terminal allowed to place an order",
 * which `evaluateReadiness` judges; the session answers "is the broker's
 * market open", which the schedule gate judges. Merging them would let one
 * kind of blocker be reported as the other, and §9.4's requirement to CONFIRM
 * reopening after a weekend would get lost inside a permission check.
 */
export interface M1M5LatestSnapshot {
  readonly permissions: Mt5PermissionSnapshot;
  /** Null means "not confirmed", which blocks entries exactly as false does. */
  readonly sessionOpen: boolean | null;
  readonly leverage: number | null;
}

/**
 * MT5's own labels, accepted as the terminal spells them. An unrecognised
 * value becomes null rather than a guess: a mode this code does not know about
 * is exactly the case where guessing is most likely to be wrong.
 */
const TRADE_MODES = ['DEMO', 'CONTEST', 'REAL'] as const;
const MARGIN_MODES = ['RETAIL_HEDGING', 'RETAIL_NETTING', 'EXCHANGE'] as const;

function asTradeMode(value: string | null): Mt5PermissionSnapshot['tradeMode'] {
  return TRADE_MODES.includes(value as (typeof TRADE_MODES)[number])
    ? (value as Mt5PermissionSnapshot['tradeMode'])
    : null;
}

function asMarginMode(value: string | null): Mt5PermissionSnapshot['marginMode'] {
  return MARGIN_MODES.includes(value as (typeof MARGIN_MODES)[number])
    ? (value as Mt5PermissionSnapshot['marginMode'])
    : null;
}

@Injectable()
export class M1M5Mt5SnapshotService {
  private readonly logger = new Logger(M1M5Mt5SnapshotService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  /** Records the collector's reading, replacing whatever was there. */
  async record(accountId: string, input: Mt5SnapshotInput): Promise<void> {
    const data = {
      capturedAt: new Date(input.capturedAtMs),
      loginId: input.loginId,
      server: input.server,
      tradeMode: input.tradeMode,
      marginMode: input.marginMode,
      terminalConnected: input.terminalConnected,
      terminalTradeAllowed: input.terminalTradeAllowed,
      terminalTradeApiDisabled: input.terminalTradeApiDisabled,
      accountTradeAllowed: input.accountTradeAllowed,
      accountTradeExpert: input.accountTradeExpert,
      sessionOpen: input.sessionOpen,
      leverage: input.leverage,
    };
    await this.prisma.xauusdM1M5Mt5Snapshot.upsert({
      where: { accountId },
      create: { accountId, ...data },
      update: data,
    });
  }

  /**
   * The latest snapshot, or null when the collector has never reported one.
   *
   * Null is returned rather than a synthesised permissive default, because
   * `evaluateReadiness` turns a null snapshot into a NO_SNAPSHOT blocker. That
   * is the correct answer before the collector has ever spoken: nothing has
   * established that this terminal may trade.
   *
   * Staleness is NOT judged here. This returns what was reported and when it
   * was captured; deciding whether that is recent enough belongs with the
   * readiness rules, in one place, rather than being split across a query and
   * a check that could disagree.
   */
  async latest(accountId: string): Promise<M1M5LatestSnapshot | null> {
    const row = await this.prisma.xauusdM1M5Mt5Snapshot.findUnique({ where: { accountId } });
    if (!row) return null;
    return {
      sessionOpen: row.sessionOpen,
      leverage: row.leverage,
      permissions: {
        capturedAtMs: row.capturedAt.getTime(),
        loginId: row.loginId,
        tradeMode: asTradeMode(row.tradeMode),
        terminalConnected: row.terminalConnected,
        terminalTradeAllowed: row.terminalTradeAllowed,
        terminalTradeApiDisabled: row.terminalTradeApiDisabled,
        accountTradeAllowed: row.accountTradeAllowed,
        accountTradeExpert: row.accountTradeExpert,
        marginMode: asMarginMode(row.marginMode),
      },
    };
  }
}
