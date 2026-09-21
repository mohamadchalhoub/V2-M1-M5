import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { StatusPill } from "@/components/StatusPill";
import { Tile } from "@/components/Tile";
import { EmptyState } from "@/components/EmptyState";
import { VolumeForm } from "./VolumeForm";
import { DrawdownResetForm } from "./DrawdownResetForm";

// §12 — "Provide a focused settings view... Keep the UI concise. Reuse the
// existing dashboard rather than rebuilding it." Same account-switcher/
// page-header/tile conventions every other page in this dashboard uses.
export default async function TrendBreakoutPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const [accounts, settings, decisions] = await Promise.all([
    api.listAccounts(),
    api.trendBreakoutSettings(accountId),
    api.trendBreakoutDecisions(accountId, { limit: 30 }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Trend Breakout Strategy"
        right={<AccountSwitcher accounts={accounts} currentAccountId={accountId} basePath="/trend-breakout" />}
      />

      <div className="rounded-lg border border-border bg-surface px-4 py-3.5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <p className="text-xs text-text-muted">Strategy version</p>
            <p className="font-mono text-sm">{settings.strategyVersion}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Execution mode</p>
            <p className="text-sm">{settings.executionMode}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Entry window" value={`${settings.entryWindow.start} - ${settings.entryWindow.end}`} />
        <Tile label="Timezone" value={settings.entryWindow.timezone} />
        <Tile
          label="Window open now?"
          value={settings.entryWindowCurrentlyOpen ? "Yes" : "No"}
          tone={settings.entryWindowCurrentlyOpen ? "ok" : "neutral"}
        />
        <Tile label="Risk policy version" value={`v${settings.riskPolicy.version}`} />
      </div>

      <div className="rounded-lg border border-border bg-surface px-4 py-3.5">
        <p className="text-sm font-medium mb-2">Account protection (§10)</p>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-xs">
          <div><dt className="text-text-muted">Max trade risk</dt><dd className="font-mono">{settings.riskPolicy.maxTradeRiskPct}% of equity</dd></div>
          <div><dt className="text-text-muted">Max combined risk</dt><dd className="font-mono">{settings.riskPolicy.maxCombinedRiskPct}% of equity</dd></div>
          <div><dt className="text-text-muted">Daily loss threshold</dt><dd className="font-mono">{settings.riskPolicy.dailyLossPct}%</dd></div>
          <div><dt className="text-text-muted">Drawdown threshold</dt><dd className="font-mono">{settings.riskPolicy.drawdownPct}% below high</dd></div>
          <div><dt className="text-text-muted">Max spread</dt><dd className="font-mono">{settings.riskPolicy.maxSpreadPctOfD}% of D</dd></div>
          <div><dt className="text-text-muted">Max quote age</dt><dd className="font-mono">{settings.riskPolicy.maxQuoteAgeSeconds}s</dd></div>
        </dl>
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-xs text-text-muted mb-2">
            Drawdown block only ever clears via an explicit reset below — never automatically.
          </p>
          <DrawdownResetForm accountId={accountId} />
        </div>
      </div>

      <ul className="flex flex-col gap-3">
        {settings.instruments.map((instrument) => (
          <li key={instrument.instrument} className="rounded-lg border border-border bg-surface px-4 py-3.5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <p className="font-medium text-sm">{instrument.instrument}</p>
                <p className="text-xs text-text-muted font-mono">broker symbol: {instrument.brokerSymbol}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill status={instrument.slotOccupied ? (instrument.slotState ?? "OCCUPIED") : "FREE"} />
                {!instrument.symbolMetadataKnown && (
                  <span className="text-xs text-warn">broker min/max/step unknown</span>
                )}
              </div>
            </div>
            <dl className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
              <div><dt className="text-text-muted">Current volume</dt><dd className="font-mono">{instrument.volume.volumeLots} lots (v{instrument.volume.version})</dd></div>
              <div><dt className="text-text-muted">Last changed by</dt><dd className="font-mono">{instrument.volume.updatedBy}</dd></div>
            </dl>
            <VolumeForm accountId={accountId} instrument={instrument} />
          </li>
        ))}
      </ul>

      <div>
        <p className="text-sm font-medium mb-2">Recent decisions (§12 observability — HOLD included)</p>
        {decisions.length === 0 ? (
          <EmptyState>No decisions logged yet for this account.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {decisions.map((d) => (
              <li key={d.id} className="rounded-lg border border-border bg-surface px-4 py-3 text-xs">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                  <span className="font-mono">{d.instrument} — {d.decisionAtBeirut} (Beirut)</span>
                  <div className="flex items-center gap-2">
                    <StatusPill status={d.action} />
                    <StatusPill status={d.orderStatus} />
                  </div>
                </div>
                {d.rejectionReason && <p className="text-text-muted">{d.rejectionReason}</p>}
                {d.action !== "HOLD" && (
                  <p className="font-mono text-text-muted">
                    entry {d.intendedEntryPrice} · SL {d.intendedStopLoss} · TP {d.intendedTakeProfit} · risk {d.estimatedStopRiskAmount} {d.estimatedStopRiskCcy}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
