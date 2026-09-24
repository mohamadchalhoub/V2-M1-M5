import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { Tile } from "@/components/Tile";
import { EmptyState } from "@/components/EmptyState";
import { formatDateTime } from "@/lib/format";
import { VolumeForm } from "./VolumeForm";

/**
 * The live dashboard for `xauusd-sar-v1` — ENGINE A, replacing the frozen
 * RSI M1/M5 threshold strategy (still viewable at /xauusd-m1m5, historical
 * only: its entry wiring is disabled in code).
 *
 * Same presentation rule as the page it replaces: unknown renders as
 * "unknown", never as a zero or a reassuring default. This page is
 * read-only — there is no approve control and no hook for one.
 */
export const dynamic = "force-dynamic";

const n = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "unknown" : v.toFixed(digits);

function stateTone(state: string): "neutral" | "ok" | "warn" | "down" {
  if (state === "ACTIVE_BUY" || state === "ACTIVE_SELL") return "ok";
  if (state === "REVERSAL_UNKNOWN") return "down";
  if (state === "DAILY_CLOSED" || state === "WAIT_MARKET_OPEN") return "neutral";
  return "warn";
}

function modeTone(mode: string): "neutral" | "ok" | "warn" {
  if (mode === "DEMO") return "ok";
  if (mode === "SHADOW") return "warn";
  return "neutral";
}

export default async function XauusdSarPage() {
  const status = await api.xauusdSarStatus();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Engine A — Stop & Reverse (xauusd-sar-v1)" />

      <div className="rounded-lg border border-border bg-surface/60 px-4 py-3 text-sm text-text-muted">
        Replaces the RSI M1/M5 threshold strategy. That strategy is frozen — its entry wiring is disabled in code —
        and remains viewable at <a href="/xauusd-m1m5" className="text-accent underline">/xauusd-m1m5</a> for
        historical trades and audit only.
      </div>

      {!status.accountConfigured ? (
        <EmptyState>No trading account is configured yet.</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <Tile label="Execution mode" value={status.executionMode} tone={modeTone(status.executionMode)} />
            <Tile label="Engine enabled" value={status.enabled ? "true" : "false"} tone={status.enabled ? "ok" : "neutral"} />
            <Tile
              label="Kill switch"
              value={status.killSwitch.active ? `ENGAGED (${status.killSwitch.source})` : "clear"}
              tone={status.killSwitch.active ? "down" : "ok"}
            />
            <Tile label="Reversal distance" value={`$${n(status.reversalDistanceUsd)}`} />
            <Tile label="Magic number" value={String(status.magic)} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Tile label="Session start" value={status.sessionStart} />
            <Tile label="Daily close" value={status.dailyClose} />
            <Tile label="Order volume" value={status.volumeLots === null ? "not configured" : `${status.volumeLots} lot`} />
          </div>

          <div className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-sm font-medium text-text-muted mb-3">Session state</h2>
            {!status.session ? (
              <EmptyState>No session has been recorded yet — the observation loop may not be running.</EmptyState>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  <Tile label="State" value={status.session.state} tone={stateTone(status.session.state)} />
                  <Tile label="Session date" value={status.session.sessionDate} />
                  <Tile label="Direction" value={status.session.direction ?? "—"} />
                  <Tile label="Broker ticket" value={status.session.brokerTicket ?? "—"} />
                </div>

                {status.session.state === "WAIT_INITIAL_DIRECTION" && (
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <Tile label="Session reference" value={n(status.session.sessionReference)} />
                    <Tile label="BUY trigger" value={n(status.session.buyTrigger)} tone="ok" />
                    <Tile label="SELL trigger" value={n(status.session.sellTrigger)} tone="down" />
                  </div>
                )}

                {(status.session.state === "ACTIVE_BUY" || status.session.state === "ACTIVE_SELL") && (
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <Tile label="Entry fill" value={n(status.session.entryFillPrice)} />
                    <Tile
                      label={status.session.direction === "BUY" ? "Highest since entry" : "Lowest since entry"}
                      value={n(status.session.extremeSinceEntry)}
                    />
                    <Tile label="Reversal level" value={n(status.session.reversalLevel)} tone="warn" />
                  </div>
                )}

                {status.session.state === "REVERSAL_UNKNOWN" && (
                  <div className="rounded-md border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
                    <strong>Blocked on an uncertain broker answer.</strong> No further evaluation happens until
                    reconciliation resolves it. Engine B is unaffected.
                    {status.session.unknownSince && ` Since ${formatDateTime(status.session.unknownSince)}.`}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-sm font-medium text-text-muted mb-3">Order volume</h2>
            <VolumeForm currentVolumeLots={status.volumeLots} />
          </div>

          <div className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-sm font-medium text-text-muted mb-3">Recent cycles</h2>
            {status.recentCycles.length === 0 ? (
              <EmptyState>No cycles recorded yet.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-text-muted border-b border-border">
                    <tr>
                      <th className="px-3 py-2">Direction</th>
                      <th className="px-3 py-2">Entry</th>
                      <th className="px-3 py-2">Entry ticket</th>
                      <th className="px-3 py-2">Entry at</th>
                      <th className="px-3 py-2">Exit</th>
                      <th className="px-3 py-2">Exit reason</th>
                      <th className="px-3 py-2">Exit at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.recentCycles.map((c) => (
                      <tr key={c.cycleId} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 font-medium">{c.direction}</td>
                        <td className="px-3 py-2 font-mono">{n(c.entryFillPrice)}</td>
                        <td className="px-3 py-2 text-text-muted">{c.entryTicket}</td>
                        <td className="px-3 py-2 text-text-muted whitespace-nowrap">{formatDateTime(c.entryAt)}</td>
                        <td className="px-3 py-2 font-mono">{c.exitFillPrice === null ? "open" : n(c.exitFillPrice)}</td>
                        <td className="px-3 py-2 text-text-muted">{c.exitReason ?? "—"}</td>
                        <td className="px-3 py-2 text-text-muted whitespace-nowrap">
                          {c.exitAt ? formatDateTime(c.exitAt) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
