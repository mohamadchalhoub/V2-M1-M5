import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { Tile } from "@/components/Tile";
import { EmptyState } from "@/components/EmptyState";
import { formatDateTime } from "@/lib/format";
import { StopEntriesControl, VolumeControl } from "./Controls";

/**
 * The live dashboard for `xauusd-m1-rsi-retest-extremes-v1`, the
 * application's single enabled entry strategy.
 *
 * Two presentation rules run through the whole page, both of them there to
 * stop it implying more than it knows:
 *
 *  1. Unknown is displayed as unknown. A null quote age, an unestablished
 *     broker session or a missing heartbeat render as "unknown"/"no data",
 *     never as a zero or a reassuring default.
 *  2. Owned exposure and foreign exposure are shown in separate sections.
 *     The page never says the ACCOUNT is flat — only ever that this
 *     application's own exposure is.
 *
 * Rendering this page performs no action; every control is its own POST.
 */
export const dynamic = "force-dynamic";

const n = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(digits);

/** The distinct schedule states the operator needs to tell apart at a glance. */
function scheduleTone(state: string): "neutral" | "ok" | "warn" | "down" {
  if (state === "ELIGIBLE_FOR_NEW_ENTRIES") return "ok";
  if (state === "FRIDAY_CLOSURE_DEADLINE_MISSED") return "down";
  if (state === "FRIDAY_LIQUIDATION_IN_PROGRESS") return "warn";
  return "neutral";
}

export default async function XauusdRsiPage() {
  let status;
  try {
    status = await api.xauusdRsiStatus();
  } catch (err) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="XAUUSD M1 RSI — live strategy dashboard" />
        <EmptyState>
          Could not read strategy status: {err instanceof Error ? err.message : String(err)}
        </EmptyState>
      </div>
    );
  }

  const { strategy, demo, slots, indicator, thresholds, patternState, quote, observation, schedule, entryEligibility, telegramDelivery, brokerSession, liquidation, exposure, order, risk, controls, heartbeats, recentDecisions, confirmedEntries } = status;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="XAUUSD M1 RSI — live strategy dashboard" />

      <section className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
        <p className="text-text-muted">
          <strong className="text-text">{strategy.version}</strong> (spec {strategy.specHash}) — the only enabled entry
          strategy in this application. Two execution slots, magic {strategy.magicNumbers.RETEST} (RETEST) and{" "}
          {strategy.magicNumbers.EXTREME} (EXTREME). Every previous strategy is retired and cannot submit an entry;
          positions they opened keep their own protective management until they resolve.
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">Status</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Execution mode"
            value={strategy.executionMode}
            tone={strategy.executionMode === "DEMO" ? "ok" : strategy.executionMode === "SHADOW" ? "warn" : "neutral"}
          />
          <Tile
            label="Account"
            value={demo.demoVerified ? `DEMO verified` : `${demo.tradeMode} — BLOCKED`}
            tone={demo.demoVerified ? "ok" : "down"}
          />
          <Tile label="Schedule" value={schedule.state} tone={scheduleTone(schedule.state)} />
          <Tile
            label="Strategy watch process"
            value={heartbeats.strategyWatch.running ? "running" : "NOT RUNNING"}
            tone={heartbeats.strategyWatch.running ? "ok" : "down"}
          />
        </div>
        <p className="text-xs text-text-muted mt-2">{schedule.detail}</p>
        <p className="text-xs text-text-muted">{heartbeats.strategyWatch.detail}</p>
        {!heartbeats.strategyWatch.running && (
          <p className="text-xs text-down mt-1">
            While the watch process is stopped nothing observes RSI, no entry can be made, and{" "}
            <strong>the Friday liquidation cannot run</strong>. It is started manually and nothing restarts it.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">
          Execution slots — at most {slots.maxConcurrentPositions} positions
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="RETEST slot"
            value={slots.RETEST.occupied === null ? "unknown" : slots.RETEST.occupied ? "HELD" : "free"}
            tone={slots.RETEST.occupied ? "warn" : "ok"}
          />
          <Tile
            label="EXTREME slot"
            value={slots.EXTREME.occupied === null ? "unknown" : slots.EXTREME.occupied ? "HELD" : "free"}
            tone={slots.EXTREME.occupied ? "warn" : "ok"}
          />
          <Tile
            label="Broker margin mode"
            value={demo.marginMode}
            tone={demo.supportsTwoIndependentPositions ? "ok" : "down"}
          />
          <Tile
            label="Reserved stop risk"
            value={slots.reservedStopRisk ? `${n(slots.reservedStopRisk.amount)} (${slots.reservedStopRisk.count})` : "—"}
          />
        </div>
        <p className="text-xs text-text-muted mt-2">{slots.note}</p>
        <p className={`text-xs mt-1 ${demo.supportsTwoIndependentPositions ? "text-text-muted" : "text-down"}`}>
          {demo.marginModeNote}
        </p>
        {slots.RETEST.reason && <p className="text-xs text-text-muted mt-1">RETEST: {slots.RETEST.reason}</p>}
        {slots.EXTREME.reason && <p className="text-xs text-text-muted mt-1">EXTREME: {slots.EXTREME.reason}</p>}
        {slots.reservedStopRisk && (
          <p className="text-xs text-text-muted mt-1">
            Combined-risk accounting includes reserved stop risk: {slots.reservedStopRisk.note}
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">Indicator</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="RSI now" value={n(indicator.currentRsi, 2)} />
          <Tile label="Period" value={String(indicator.period)} />
          <Tile
            label="Applied to"
            value={`${indicator.appliedPrice} (${indicator.parityVerified ? "verified" : "assumed"})`}
            tone={indicator.parityVerified ? "ok" : "warn"}
          />
          <Tile
            label="Warm-up"
            value={indicator.warmedUp ? "complete" : `${indicator.closedBarsApplied}/${indicator.warmupBarsRequired}`}
            tone={indicator.warmedUp ? "ok" : "warn"}
          />
        </div>
        <p className="text-xs text-text-muted mt-2">
          Provenance: {indicator.appliedPriceProvenance} Source: {indicator.paritySource}.
        </p>
        <p className="text-xs text-text-muted mt-1">{indicator.flatPriceBehaviourNote}</p>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">Thresholds</h2>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Sell 2" value={String(thresholds.sell2)} />
          <Tile label="Sell 1" value={String(thresholds.sell1)} />
          <Tile label="Buy 1" value={String(thresholds.buy1)} />
          <Tile label="Buy 2" value={String(thresholds.buy2)} />
          <Tile label="Extreme SELL" value={String(thresholds.extremeSell)} />
          <Tile label="Extreme BUY" value={String(thresholds.extremeBuy)} />
        </div>
        <p className="text-xs text-text-muted mt-2">{thresholds.note}</p>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">Pattern state</h2>
        {patternState ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label="SELL peak retest"
              value={patternState.sellPeakRetest.phase}
              tone={patternState.sellPeakRetest.phase === "EXTREME_FROZEN" ? "warn" : "neutral"}
            />
            <Tile
              label="BUY trough retest"
              value={patternState.buyTroughRetest.phase}
              tone={patternState.buyTroughRetest.phase === "EXTREME_FROZEN" ? "warn" : "neutral"}
            />
            <Tile label="Extreme SELL" value={patternState.extremeSell.phase} />
            <Tile label="Extreme BUY" value={patternState.extremeBuy.phase} />
          </div>
        ) : (
          <EmptyState>
            No pattern state — the watch process has not written a state file in this environment yet.
          </EmptyState>
        )}
        {patternState && (
          <p className="text-xs text-text-muted mt-2">
            Frozen SELL peak: {n(patternState.sellPeakRetest.frozenExtreme, 4)} · running max{" "}
            {n(patternState.sellPeakRetest.runningExtreme, 4)} — Frozen BUY trough:{" "}
            {n(patternState.buyTroughRetest.frozenExtreme, 4)} · running min{" "}
            {n(patternState.buyTroughRetest.runningExtreme, 4)} — previous RSI {n(patternState.previousRsi, 4)} over{" "}
            {patternState.observationCount.toLocaleString()} observations.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">Market data</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Bid" value={n(quote.bid, 2)} />
          <Tile label="Ask" value={n(quote.ask, 2)} />
          <Tile
            label="Quote age"
            value={quote.ageSeconds === null ? "unknown" : `${quote.ageSeconds.toFixed(0)}s`}
            tone={quote.fresh ? "ok" : "down"}
          />
          <Tile
            label="Broker session"
            value={brokerSession.open === null ? "UNKNOWN" : brokerSession.open ? "open" : "closed"}
            tone={brokerSession.open === true ? "ok" : brokerSession.open === false ? "down" : "warn"}
          />
        </div>
        <p className="text-xs text-text-muted mt-2">
          Quote at {quote.tickAt ? formatDateTime(quote.tickAt) : "—"}. {brokerSession.detail}
        </p>
        <p className="text-xs text-text-muted mt-1">
          Observation mode <strong>{observation.mode}</strong>: {observation.modeLimitation}
        </p>
        <p className="text-xs text-text-muted mt-1">
          {observation.ticksApplied.toLocaleString()} observations applied · {observation.duplicatesRejected.toLocaleString()} duplicates
          rejected · {observation.outOfOrderRejected.toLocaleString()} out-of-order rejected ·{" "}
          {observation.gapResets.toLocaleString()} gap resets
          {observation.needsReseed ? " · INDICATOR RESEED OUTSTANDING" : ""}
        </p>
        <p
          className={`text-xs mt-1 ${
            observation.cadence.withinTarget === false ? "text-down" : "text-text-muted"
          }`}
        >
          Measured cadence: {observation.cadence.detail}
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">
          Entry eligibility — every gate
        </h2>
        <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm flex flex-col gap-2">
          {entryEligibility ? (
            <>
              <p>
                Can enter now:{" "}
                <strong className={entryEligibility.canEnterNow ? "text-emerald-400" : "text-amber-400"}>
                  {entryEligibility.canEnterNow
                    ? "yes — no gate is blocking"
                    : `no — blocked by ${entryEligibility.blockingGates.join(", ")}`}
                </strong>
              </p>
              <ul className="flex flex-col gap-1">
                {entryEligibility.gates.map((g) => (
                  <li key={g.gate} className="flex gap-2 text-xs">
                    <span className={`font-mono w-6 ${g.passed ? "text-emerald-400" : "text-amber-400"}`}>
                      {g.passed ? "ok" : "no"}
                    </span>
                    <span className="font-mono w-44 shrink-0">{g.gate}</span>
                    <span className="text-text-muted">{g.detail}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-text-muted mt-1">Evaluated later, against an actual candidate order:</p>
              <ul className="text-xs text-text-muted list-disc pl-5">
                {entryEligibility.evaluatedLater.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
              <p className="text-xs text-text-muted">{entryEligibility.note}</p>
            </>
          ) : (
            <p className="text-xs text-text-muted">
              The backend currently running predates this panel and does not report the gate breakdown. Restart the
              backend to populate it. Every gate is still enforced — only this summary is missing, so read the
              indicator, quote, schedule, controls and slot panels below instead.
            </p>
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {telegramDelivery && (telegramDelivery.failedPending > 0 || telegramDelivery.gaveUp > 0) && (
        <section>
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm flex flex-col gap-1">
            <p className="font-semibold text-amber-400">Telegram alerts are not being delivered</p>
            {telegramDelivery.failedPending > 0 && (
              <p className="text-xs">
                {telegramDelivery.failedPending} alert(s) failed and are being retried
                {telegramDelivery.oldestFailedAgeSeconds !== null
                  ? `; the oldest is ${Math.round(telegramDelivery.oldestFailedAgeSeconds / 60)} minute(s) old`
                  : ""}
                .
              </p>
            )}
            {telegramDelivery.gaveUp > 0 && (
              <p className="text-xs">
                {telegramDelivery.gaveUp} alert(s) were abandoned after the retry limit and will never arrive.
              </p>
            )}
            {telegramDelivery.lastError && (
              <p className="text-xs font-mono text-text-muted">{telegramDelivery.lastError}</p>
            )}
            <p className="text-xs text-text-muted">
              Trading is unaffected — this is delivery only. Silence from Telegram does not mean nothing happened.
            </p>
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">Schedule</h2>
        <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm flex flex-col gap-1">
          <p>
            Now: <span className="font-mono">{schedule.nowBeirut}</span> ({schedule.timeZone})
          </p>
          <p className="text-text-muted">Daily entry pause: {schedule.dailyPause}</p>
          <p className="text-text-muted">Friday entry cutoff: {schedule.fridayEntryCutoff}</p>
          <p className="text-text-muted">Friday closure deadline: {schedule.fridayClosureDeadline}</p>
          <p>
            Next eligible for entries: <strong>{schedule.nextEligibleLabel}</strong>
          </p>
          <p>
            Next Friday deadline:{" "}
            <strong>{schedule.nextFridayDeadline ? schedule.nextFridayDeadline.beirut : "unknown"}</strong>
          </p>
          {schedule.blockReason && (
            <p className="text-warn">
              Entries blocked — {schedule.blockReason}: {schedule.detail}
            </p>
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">Friday liquidation</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Tile
            label="Phase"
            value={liquidation.phase}
            tone={
              liquidation.phase === "DEADLINE_MISSED" ? "down" : liquidation.phase === "IN_PROGRESS" ? "warn" : liquidation.phase === "CONFIRMED_FLAT" ? "ok" : "neutral"
            }
          />
          <Tile label="Deadline" value={liquidation.deadline ? liquidation.deadline.beirut : "—"} />
          <Tile
            label="Owned exposure"
            value={liquidation.ownedExposureFlat === null ? "unknown" : liquidation.ownedExposureFlat ? "flat (broker-confirmed)" : "OPEN"}
            tone={liquidation.ownedExposureFlat ? "ok" : "warn"}
          />
        </div>
        <p className="text-xs text-text-muted mt-2">{liquidation.detail}</p>
        {liquidation.outstandingItems.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="text-left py-1">Ticket</th>
                  <th className="text-left py-1">Status</th>
                  <th className="text-left py-1">Attempts</th>
                  <th className="text-left py-1">Ownership</th>
                  <th className="text-left py-1">Last error</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {liquidation.outstandingItems.map((i) => (
                  <tr key={`${i.deadline}-${i.ticket}`} className="border-t border-border">
                    <td className="py-1">{i.ticket}</td>
                    <td className="py-1">{i.status}</td>
                    <td className="py-1">{i.attempts}</td>
                    <td className="py-1 font-sans text-xs">{i.ownership}</td>
                    <td className="py-1 font-sans text-xs text-down">{i.lastError ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">Exposure</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-text-muted mb-2">
              Owned by this application ({exposure.owned.length})
            </p>
            {exposure.owned.length === 0 ? (
              <p className="text-sm text-text-muted">None.</p>
            ) : (
              <ul className="text-sm flex flex-col gap-1">
                {exposure.owned.map((e) => (
                  <li key={`${e.kind}-${e.ticket}`} className="font-mono text-xs">{e.description}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border border-border bg-surface px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-text-muted mb-2">
              Foreign / manual ({exposure.foreign.length}) — never closed or modified by this application
            </p>
            {exposure.foreign.length === 0 ? (
              <p className="text-sm text-text-muted">None.</p>
            ) : (
              <ul className="text-sm flex flex-col gap-1">
                {exposure.foreign.map((e) => (
                  <li key={`${e.kind}-${e.ticket}`} className="font-mono text-xs">{e.description}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {exposure.occupancyBlocksNewEntries && (
          <p className="text-xs text-warn mt-2">
            Existing XAUUSD exposure occupies the one-position slot, so no new entry can be opened — this counts
            foreign and manual positions too.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">Order and risk</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Volume" value={`${order.volumeLots} lots`} />
          <Tile label="Take profit" value={`$${order.takeProfitUsd}`} />
          <Tile label="Stop loss" value={`$${order.stopLossUsd}`} />
          <Tile label="Max entry drift" value={`${order.maxEntryDeviationPoints} pt`} />
        </div>
        <p className="text-xs text-text-muted mt-2">{order.bracketNote}</p>
        <p className="text-xs text-text-muted mt-1">
          Volume source: {order.volumeSource} — {order.volumeSourceDetail}
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mt-3">
          <Tile label="Per-trade risk cap" value={`${risk.stopRiskCapPct}%`} />
          <Tile label="Combined risk cap" value={`${risk.combinedRiskCapPct}%`} />
          <Tile label="Daily loss cap" value={`${risk.dailyLossCapPct}%`} />
          <Tile label="Drawdown cap" value={`${risk.drawdownCapPct}%`} />
        </div>
        {risk.current && (
          <p className="text-xs text-text-muted mt-2">
            Equity {n(risk.current.equity)} {demo.accountCurrency} · today&apos;s loss {n(risk.current.todaysLossAmount)} ·
            drawdown {n(risk.current.currentDrawdownPct)}% · contract size {risk.current.contractSize ?? "unknown"} ·
            {" "}profit currency {risk.current.profitCurrency} · conversion rate {n(risk.current.conversionRate, 5)}
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">Controls</h2>
        <div className="rounded-lg border border-border bg-surface px-4 py-3 flex flex-col gap-4">
          {controls.killSwitchActive && (
            <p className="text-sm text-down">
              KILL SWITCH ACTIVE — {controls.killSwitchSource}. No new order can be queued or sent. Protective
              closures, reconciliation and Friday liquidation still run.
            </p>
          )}
          <StopEntriesControl currentlyActive={controls.stopNewEntriesActive} source={controls.stopNewEntriesSource} />
          <VolumeControl
            current={order.volumeLots}
            min={order.brokerConstraints.minLots}
            max={order.brokerConstraints.maxLots}
            step={order.brokerConstraints.stepLots}
          />
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">
          Recent decisions — including every skipped signal and why
        </h2>
        {recentDecisions.length === 0 ? (
          <EmptyState>No decisions recorded yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="text-left py-1">Observed (market)</th>
                  <th className="text-left py-1">Recorded</th>
                  <th className="text-left py-1">Slot</th>
                  <th className="text-left py-1">Setup</th>
                  <th className="text-left py-1">Dir</th>
                  <th className="text-left py-1">RSI</th>
                  <th className="text-left py-1">Status</th>
                  <th className="text-left py-1">Outcome / reason</th>
                </tr>
              </thead>
              <tbody>
                {recentDecisions.map((d) => (
                  <tr key={d.id} className="border-t border-border align-top">
                    <td className="py-1 font-mono text-xs whitespace-nowrap">{formatDateTime(d.observedAt)}</td>
                    <td className="py-1 font-mono text-xs whitespace-nowrap text-text-muted">{formatDateTime(d.evaluatedAt)}</td>
                    <td className="py-1 font-mono text-xs">{d.ruleFamily ?? "—"}</td>
                    <td className="py-1 text-xs">{d.setupKinds.join(", ")}</td>
                    <td className="py-1 font-mono text-xs">{d.direction}</td>
                    <td className="py-1 font-mono text-xs">
                      {n(d.previousRsi, 2)} → {n(d.rsi, 2)}
                    </td>
                    <td className="py-1 font-mono text-xs">{d.orderStatus}</td>
                    <td className="py-1 text-xs text-text-muted">
                      {d.orderStatus === "FILLED"
                        ? `ticket ${d.ticket} @ ${n(d.filledPrice)} (slippage ${n(d.slippagePoints, 1)}pt)`
                        : d.skipReason ?? d.executionError ?? d.reasoning}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-3">
          Broker-confirmed entries ({confirmedEntries.count})
        </h2>
        {confirmedEntries.items.length === 0 ? (
          <EmptyState>No broker-confirmed entries yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="text-left py-1">Filled</th>
                  <th className="text-left py-1">Ticket</th>
                  <th className="text-left py-1">Requested → filled</th>
                  <th className="text-left py-1">Slippage</th>
                  <th className="text-left py-1">SL requested → broker</th>
                  <th className="text-left py-1">Protection</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs">
                {confirmedEntries.items.map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="py-1 whitespace-nowrap">{e.filledAt ? formatDateTime(e.filledAt) : "—"}</td>
                    <td className="py-1">{e.ticket ?? "—"}</td>
                    <td className="py-1">
                      {n(e.requestedPrice)} → {n(e.filledPrice)}
                    </td>
                    <td className="py-1">{n(e.slippagePoints, 1)}pt</td>
                    <td className="py-1">
                      {n(e.requestedStopLoss)} → {n(e.brokerStopLoss)}
                    </td>
                    <td className={`py-1 ${e.protectionMatchesRequest === false ? "text-down" : ""}`}>
                      {e.protectionMatchesRequest === null
                        ? "not verified"
                        : e.protectionMatchesRequest
                          ? "matches"
                          : "MISMATCH"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
