import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { Tile } from "@/components/Tile";
import { EmptyState } from "@/components/EmptyState";
import { formatMoney, formatNumber, formatDateTime, formatRelative } from "@/lib/format";
import { VolumeForm } from "./VolumeForm";
import { StopEntriesForm } from "./StopEntriesForm";
import { ClosePositionForm } from "./ClosePositionForm";

// This page renders live status only — no action fires just from loading it
// (every mutating control below is its own POST-only form/server action).
export default async function GoldDemoPage() {
  const [status, news, aiSummaries] = await Promise.all([
    api.goldExecutionStatus(),
    api.goldNews().catch(() => ({ items: [], coverage: [] })),
    api.goldAiSummaries().catch(() => ({ summaries: [] })),
  ]);

  const mode = status.accountMode ?? status.mode ?? "OFF";
  const isDemoVerified = status.accountTradeMode === "DEMO";

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Gold (XAUUSD) DEMO — live execution dashboard" />

      <section className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
        <p className="text-text-muted">
          This is the LIVE gold DEMO execution dashboard — distinct from{" "}
          <a href="/research/xauusd-confirmed-retest" className="text-accent hover:underline">
            Gold Retest Research
          </a>{" "}
          (backtest-only, no account). Data below is mixed-provenance — each section is labeled with where its
          numbers come from (real broker state, historical audit records, or AI/deterministic narration); no
          single claim covers the whole page.
        </p>
        {status.eurusd && <p className="text-text-muted mt-1">{status.eurusd.note}</p>}
      </section>

      {status.error && <EmptyState>{status.error}</EmptyState>}

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Strategy / safety state</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Tile label="Execution mode" value={mode} tone={mode === "DEMO" ? "ok" : mode === "SHADOW" ? "warn" : "neutral"} />
          <Tile label="Account trade mode" value={status.accountTradeMode ?? "unknown"} tone={isDemoVerified ? "ok" : "down"} />
          <Tile label="Gold kill switch" value={status.killSwitchActive ? "ENGAGED" : "clear"} tone={status.killSwitchActive ? "down" : "ok"} />
          <Tile label="Stop new entries" value={status.stopNewEntriesActive ? "STOPPED" : "active"} tone={status.stopNewEntriesActive ? "warn" : "ok"} />
          <Tile label="Entry window (Beirut)" value={status.entryWindow?.open ? "OPEN" : "closed"} tone={status.entryWindow?.open ? "ok" : "neutral"} />
          <Tile label="Strategy version" value={status.strategyVersion} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Collector / quote freshness</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Tile
            label="Collector heartbeat"
            value={status.collectorHeartbeat?.lastHeartbeatAt ? formatRelative(status.collectorHeartbeat.lastHeartbeatAt) : "never"}
            tone={status.collectorHeartbeat?.stale ? "down" : "ok"}
          />
          <Tile label="MT5 connected" value={status.collectorHeartbeat?.mt5Connected ? "yes" : "no"} tone={status.collectorHeartbeat?.mt5Connected ? "ok" : "down"} />
          <Tile
            label="Live quote"
            value={status.liveQuote?.bid ? `${formatNumber(status.liveQuote.bid, 2)} / ${formatNumber(status.liveQuote?.ask ?? 0, 2)}` : "—"}
            tone={status.liveQuote?.stale ? "down" : "ok"}
          />
          <Tile
            label="Live quote age"
            value={status.liveQuote?.ageMs != null ? formatRelative(new Date(Date.now() - status.liveQuote.ageMs).toISOString()) : "unknown"}
            tone={status.liveQuote?.stale ? "down" : "ok"}
          />
          <Tile label="Account snapshot" value={status.dataFreshness?.accountSnapshotStale ? "stale" : "fresh"} tone={status.dataFreshness?.accountSnapshotStale ? "down" : "ok"} />
          <Tile label="Symbol metadata (broker limits)" value={status.dataFreshness?.symbolMetadataStale ? "stale" : "fresh"} tone={status.dataFreshness?.symbolMetadataStale ? "down" : "ok"} />
        </div>
        {status.collectorHeartbeat?.lastError && <p className="text-xs text-down mt-2">Last collector error: {status.collectorHeartbeat.lastError}</p>}
      </section>

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Gold scheduler (standalone process — separate from this backend&apos;s own uptime)</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Tile
            label="Scheduler heartbeat"
            value={status.goldScheduler?.lastCycleAtUtc ? formatRelative(status.goldScheduler.lastCycleAtUtc) : "never observed"}
            tone={status.goldScheduler?.stale ? "down" : "ok"}
          />
          <Tile
            label="Active levels"
            value={status.goldScheduler?.activeLevelIds && status.goldScheduler.activeLevelIds.length > 0 ? String(status.goldScheduler.activeLevelIds.length) : "none"}
          />
        </div>
        {status.goldScheduler?.stale && (
          <p className="text-xs text-down mt-2">
            No recent scheduler cycle observed — this reads the standalone scheduler process&apos;s own on-disk
            heartbeat, not this backend&apos;s uptime. The backend being up does NOT mean the gold watch cycle is
            currently running.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Controls</h2>
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface px-4 py-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-text-muted mb-2">
              Volume setting (real live order volume: {status.settings?.volumeLots ?? "—"} lots)
            </p>
            <VolumeForm
              currentVolumeLots={status.settings?.volumeOverride?.value ?? 0.01}
              minLots={status.volumeConstraints?.minLots ?? 0.01}
              maxLots={status.volumeConstraints?.maxLots ?? 1}
              stepLots={status.volumeConstraints?.stepLots ?? 0.01}
            />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-text-muted mb-2">New entries</p>
            <StopEntriesForm currentlyActive={status.stopNewEntriesActive} />
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Open positions ({status.openPositions?.length ?? 0})</h2>
        {!status.openPositions || status.openPositions.length === 0 ? (
          <EmptyState>No open gold positions right now.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-text-muted border-b border-border">
                <tr>
                  <th className="px-4 py-2.5">Ticket</th>
                  <th className="px-4 py-2.5">Side</th>
                  <th className="px-4 py-2.5">Volume</th>
                  <th className="px-4 py-2.5">Entry</th>
                  <th className="px-4 py-2.5">SL / TP</th>
                  <th className="px-4 py-2.5">Protected</th>
                  <th className="px-4 py-2.5">Floating P/L</th>
                  <th className="px-4 py-2.5">Opened</th>
                  <th className="px-4 py-2.5">Action</th>
                </tr>
              </thead>
              <tbody>
                {status.openPositions.map((p) => (
                  <tr key={p.ticket} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 font-mono">{p.ticket}</td>
                    <td className="px-4 py-2.5">{p.side}</td>
                    <td className="px-4 py-2.5 font-mono">{formatNumber(p.volume)}</td>
                    <td className="px-4 py-2.5 font-mono">{formatNumber(p.entryPrice, 2)}</td>
                    <td className="px-4 py-2.5 font-mono">
                      {p.stopLoss ?? "NONE"} / {p.takeProfit ?? "NONE"}
                    </td>
                    <td className={`px-4 py-2.5 font-medium ${p.isProtected ? "text-ok" : "text-down"}`}>{p.isProtected ? "yes" : "NO"}</td>
                    <td className={`px-4 py-2.5 font-mono ${p.floatingPnl >= 0 ? "text-ok" : "text-down"}`}>{formatMoney(p.floatingPnl)}</td>
                    <td className="px-4 py-2.5 text-text-muted">{formatRelative(p.openedAt)}</td>
                    <td className="px-4 py-2.5">
                      <ClosePositionForm positionId={p.ticket} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Recent closed trades</h2>
        {!status.closedTrades || status.closedTrades.length === 0 ? (
          <EmptyState>No closed gold trades yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-text-muted border-b border-border">
                <tr>
                  <th className="px-4 py-2.5">Deal ticket</th>
                  <th className="px-4 py-2.5">Side</th>
                  <th className="px-4 py-2.5">Volume</th>
                  <th className="px-4 py-2.5">Price</th>
                  <th className="px-4 py-2.5">Realized P/L</th>
                  <th className="px-4 py-2.5">Executed</th>
                </tr>
              </thead>
              <tbody>
                {status.closedTrades.map((t) => (
                  <tr key={t.dealTicket} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 font-mono">{t.dealTicket}</td>
                    <td className="px-4 py-2.5">{t.side}</td>
                    <td className="px-4 py-2.5 font-mono">{formatNumber(t.volume)}</td>
                    <td className="px-4 py-2.5 font-mono">{formatNumber(t.price, 2)}</td>
                    <td className={`px-4 py-2.5 font-mono ${t.realizedPnl >= 0 ? "text-ok" : "text-down"}`}>{formatMoney(t.realizedPnl)}</td>
                    <td className="px-4 py-2.5 text-text-muted">{formatDateTime(t.executedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Recent decisions / skip reasons — Historical touch — audit only</h2>
        <p className="text-xs text-text-muted mb-2">
          Each row is a historical M1 touch record kept for audit purposes. &quot;Intended direction&quot; is what the
          strategy would have done at that touch; it is NOT proof of execution — check &quot;Execution status&quot;
          separately for whether an order actually reached the broker.
        </p>
        {!status.recentDecisions || status.recentDecisions.length === 0 ? (
          <EmptyState>No decisions evaluated yet.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {status.recentDecisions.slice(0, 10).map((d) => (
              <li key={d.id} className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    Intended direction: {d.action} — Execution status: {d.orderStatus}
                  </span>
                </div>
                <div className="text-xs text-text-muted mt-1 flex flex-wrap gap-x-4">
                  <span>Touch closed: {d.touchEndTIso ? formatDateTime(d.touchEndTIso) : "unknown"}</span>
                  <span>Logged/evaluated: {formatDateTime(d.evaluatedAt)}</span>
                </div>
                <p className="text-xs text-text-muted mt-1">{d.reasoning}</p>
                {d.riskManagerRejectionReason && <p className="text-xs text-down mt-1">Skip reason: {d.riskManagerRejectionReason}</p>}
                {d.executionError && <p className="text-xs text-down mt-1">Execution error: {d.executionError}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Telegram notifications sent (this gold path)</h2>
        {!status.recentNotifications || status.recentNotifications.length === 0 ? (
          <EmptyState>None yet.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {status.recentNotifications.map((n, i) => (
              <li key={i} className="rounded border border-border bg-surface px-3 py-2">
                <span className={`font-medium ${n.status === "SENT" ? "text-ok" : "text-down"}`}>{n.eventType}</span>{" "}
                <span className="text-text-muted">{formatDateTime(n.createdAt)}</span>
                <p className="text-text-muted">{n.text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Gold-relevant news / calendar (read-only)</h2>
        <div className="mb-2 flex flex-wrap gap-2 text-xs">
          {news.coverage.map((c) => {
            const healthTone =
              c.ingestionHealth === "OK" ? "border-ok text-ok" : c.ingestionHealth === "UNKNOWN" ? "border-border text-text-muted" : "border-down text-down";
            return (
              <span key={c.source} className={`rounded-full px-2 py-1 border ${healthTone}`} title="Data age and job-execution health are reported separately — fresh data does not by itself prove the ingestion job is currently running.">
                {c.source}: {c.totalRows} rows · data {c.mostRecentSourceDataAtIso ? formatRelative(c.mostRecentSourceDataAtIso) : "never"}
                {c.sourceDataStale ? " (stale)" : ""} · ingestion: {c.ingestionHealth}
                {c.lastIngestionRunAtIso ? ` (${formatRelative(c.lastIngestionRunAtIso)})` : ""}
              </span>
            );
          })}
        </div>
        {news.items.length === 0 ? (
          <EmptyState>No USD/XAU-relevant events ingested yet.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {news.items.slice(0, 15).map((n) => (
              <li key={n.id} className="rounded border border-border bg-surface px-3 py-2">
                <span className="font-medium">{n.title}</span>{" "}
                <span className="text-text-muted">({n.category}) — {n.scheduledAtBeirut} Beirut</span>
                {n.sourceUrl && (
                  <a href={n.sourceUrl} target="_blank" rel="noreferrer" className="ml-2 text-accent hover:underline">
                    source
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">AI summaries (factual, event-gated)</h2>
        {aiSummaries.summaries.length === 0 ? (
          <EmptyState>No AI summaries generated yet.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {aiSummaries.summaries.map((s) => {
              const isFallback = s.provider === "fallback";
              return (
                <li key={s.id} className="rounded border border-border bg-surface px-3 py-2">
                  <span className="font-medium">{s.eventType}</span>{" "}
                  {isFallback ? (
                    <span className="rounded-full border border-warn px-1.5 py-0.5 text-warn font-medium">
                      FALLBACK — deterministic, not AI-generated
                    </span>
                  ) : (
                    <span className="text-text-muted">
                      AI-generated ({s.provider}
                      {s.model ? `/${s.model}` : ""})
                    </span>
                  )}
                  <div className="text-text-muted mt-1 flex flex-wrap gap-x-4">
                    <span>Source event: {formatDateTime(s.sourceDataTimestampIso)}</span>
                    <span>Summary generated: {formatDateTime(s.generatedAtIso)}</span>
                  </div>
                  <p className="text-text-muted mt-1">{s.summary}</p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
