import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { Tile } from "@/components/Tile";
import { EmptyState } from "@/components/EmptyState";
import { formatDateTime } from "@/lib/format";

/**
 * The live dashboard for `xauusd-m1-m5-rsi-threshold-v2`.
 *
 * Three presentation rules run through this whole page, each there to stop it
 * implying more than it knows:
 *
 *  1. **Unknown renders as unknown.** A missing heartbeat, an unestablished
 *     broker session or an absent MT5 snapshot show as "unknown", never as a
 *     zero or a reassuring default. A dashboard that fills gaps with plausible
 *     values is worse than no dashboard, because it is trusted.
 *
 *  2. **An unlock is never shown as a signal.** 98.5 and 1.5 have no
 *     standalone entry meaning in this strategy — they only release a
 *     post-loss lock. The lock panel says so in words, because the single
 *     most likely misreading of this page is that an unlock was a missed
 *     trade.
 *
 *  3. **Nothing here approves a trade.** This page is read-only by design.
 *     §8 forbids per-trade approval by a human, by AI, by Telegram or by the
 *     dashboard, so there is no approve control and no hook for one.
 *
 * Rendering this page performs no action.
 */
export const dynamic = "force-dynamic";

const n = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "unknown" : v.toFixed(digits);

function scheduleTone(state: string): "neutral" | "ok" | "warn" | "down" {
  if (state === "ELIGIBLE_FOR_NEW_ENTRIES") return "ok";
  if (state === "FRIDAY_CLOSURE_DEADLINE_MISSED") return "down";
  if (state === "FRIDAY_LIQUIDATION_IN_PROGRESS") return "warn";
  return "neutral";
}

function modeTone(mode: string): "neutral" | "ok" | "warn" | "down" {
  if (mode === "DEMO") return "ok";
  if (mode === "SHADOW") return "warn";
  return "neutral";
}

export default async function XauusdM1M5Page() {
  let view;
  try {
    view = await api.xauusdM1M5Dashboard();
  } catch (err) {
    return (
      <div className="space-y-6">
        <PageHeader title="XAUUSD M1/M5 RSI threshold" />
        <EmptyState>
          <strong>The strategy API could not be reached.</strong> {(err as Error).message}. Nothing can be
          concluded about the strategy from this page while the API is unreachable — in particular, this is NOT
          evidence that the bot is stopped or that there is no open exposure.
        </EmptyState>
      </div>
    );
  }

  const heartbeatOk = view.heartbeat.fresh === true;

  return (
    <div className="space-y-6">
      <PageHeader
        title="XAUUSD M1/M5 RSI threshold"
        right={
          <span className="text-xs font-mono text-text-muted">
            {view.strategyVersion} · spec {view.specHash}
            {view.buildCommit ? ` · build ${view.buildCommit}` : ""}
          </span>
        }
      />

      {/* --- What is running, and whether it is actually running. --- */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Execution mode" value={view.executionMode} tone={modeTone(view.executionMode)} />
        <Tile
          label="Observation loop"
          value={heartbeatOk ? "running" : "NO HEARTBEAT"}
          tone={heartbeatOk ? "ok" : "down"}
        />
        <Tile label="Account" value={view.accountLabel ?? "unknown"} />
        <Tile
          label="Last cycle"
          value={view.heartbeat.lastCycleAt ? formatDateTime(view.heartbeat.lastCycleAt) : "never"}
        />
      </section>

      {!heartbeatOk && (
        <EmptyState>
          <strong>The observation loop is not reporting.</strong> While it is not running, nothing observes RSI,
          no entry can occur, and the Friday pre-weekend liquidation does not run. Everything below is the last
          recorded state, not the current one.
        </EmptyState>
      )}

      {/* --- Entry rules, restated so the page is self-explaining. --- */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">Entry rules in force</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile label="Indicator" value={view.indicator} />
          <Tile label="SELL crossing" value={`RSI up through ${view.entryThresholds.sell}`} />
          <Tile label="BUY crossing" value={`RSI down through ${view.entryThresholds.buy}`} />
          <Tile label="Take profit" value={`$${n(view.brackets.takeProfitUsd)}`} />
          <Tile label="Stop loss" value={`$${n(view.brackets.stopLossUsd)}`} />
        </div>
      </section>

      {/* --- Per timeframe. Two independent slots, never merged. --- */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">Timeframes</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          {view.timeframes.map((tf) => (
            <div key={tf.timeframe} className="rounded-lg border border-border p-4 space-y-2">
              <div className="flex items-baseline justify-between">
                <h3 className="font-semibold">{tf.timeframe}</h3>
                <span className="text-xs font-mono text-text-muted">magic {tf.magicNumber}</span>
              </div>
              <dl className="text-sm space-y-1">
                <div className="flex justify-between gap-4">
                  <dt className="text-text-muted">Engine</dt>
                  <dd className="font-mono">{tf.health}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-text-muted">SELL arming</dt>
                  <dd className="font-mono text-right">{tf.sellArming}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-text-muted">BUY arming</dt>
                  <dd className="font-mono text-right">{tf.buyArming}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-text-muted">Occupancy</dt>
                  <dd className="font-mono text-right">{tf.occupancy}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </section>

      {/* --- Schedule. --- */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">Schedule (Asia/Beirut)</h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <Tile label="State" value={view.schedule.state} tone={scheduleTone(view.schedule.state)} />
          <Tile
            label="Next eligible"
            value={view.schedule.nextEligibleT ? formatDateTime(new Date(view.schedule.nextEligibleT).toISOString()) : "unknown"}
          />
          <Tile
            label="Friday deadline"
            value={view.schedule.fridayDeadlineT ? formatDateTime(new Date(view.schedule.fridayDeadlineT).toISOString()) : "not in window"}
          />
        </div>
        <p className="text-sm text-text-muted">{view.schedule.detail}</p>
      </section>

      {/* --- MT5 permissions. Fresh quotes are not permission to trade. --- */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">MT5 readiness</h2>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <Tile label="Ready to trade" value={view.mt5.ready ? "yes" : "NO"} tone={view.mt5.ready ? "ok" : "down"} />
          <Tile
            label="Hedging"
            value={view.mt5.hedgingSupported === null ? "unknown" : view.mt5.hedgingSupported ? "RETAIL_HEDGING" : "NOT hedging"}
            tone={view.mt5.hedgingSupported === true ? "ok" : "down"}
          />
          <Tile label="Blockers" value={String(view.mt5.blockers.length)} tone={view.mt5.blockers.length > 0 ? "warn" : "ok"} />
        </div>
        <p className="text-sm text-text-muted">{view.mt5.summary}</p>
        {view.mt5.blockers.length > 0 && (
          <ul className="text-sm space-y-1">
            {view.mt5.blockers.map((b) => (
              <li key={b.code} className="rounded border border-border p-2">
                <span className="font-mono text-xs">{b.code}</span>
                <span className="text-text-muted"> ({b.origin})</span>
                <p>{b.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- Post-loss locks. --- */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">Post-loss directional locks</h2>
        <p className="text-sm text-text-muted">
          A lock blocks one direction on one timeframe after a realized loss. Releasing a lock is{" "}
          <strong>not</strong> an entry and never becomes one — after an unlock, a normal crossing must still occur
          before anything is traded.
        </p>
        <div className="grid gap-3 lg:grid-cols-2">
          {view.locks.map((lock) => (
            <div
              key={`${lock.timeframe}-${lock.direction}`}
              className="rounded-lg border border-border p-4 space-y-1 text-sm"
            >
              <div className="flex items-baseline justify-between">
                <h3 className="font-semibold">
                  {lock.timeframe} {lock.direction}
                </h3>
                <span className={`font-mono text-xs ${lock.state === "ACTIVE" ? "text-danger" : "text-text-muted"}`}>
                  {lock.state}
                </span>
              </div>
              <p className="text-text-muted">{lock.unlockCondition}</p>
              {lock.state === "ACTIVE" && (
                <dl className="space-y-1 pt-1">
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-muted">Caused by</dt>
                    <dd className="font-mono text-right">{lock.causingTrade ?? "unknown"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-muted">Realized loss</dt>
                    <dd className="font-mono">{n(lock.netRealizedLoss)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-muted">Current RSI</dt>
                    <dd className="font-mono">{n(lock.currentRsi, 4)}</dd>
                  </div>
                </dl>
              )}
              {lock.lastUnlock && <p className="text-xs text-text-muted pt-1">Last unlock: {lock.lastUnlock}</p>}
            </div>
          ))}
        </div>
      </section>

      {/* --- Anything degrading observation right now. --- */}
      {view.observationLimitations.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-text-muted">Observation limitations</h2>
          <ul className="text-sm space-y-1">
            {view.observationLimitations.map((limitation) => (
              <li key={limitation} className="rounded border border-warn/40 bg-warn/5 p-2">
                {limitation}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
