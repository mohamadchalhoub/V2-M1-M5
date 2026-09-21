import Link from "next/link";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { Tile } from "@/components/Tile";
import { HealthTileRow } from "@/components/HealthTileRow";
import { StatusPill } from "@/components/StatusPill";
import { EmptyState } from "@/components/EmptyState";
import { formatMoney, formatNumber, formatDateTime, formatRelative } from "@/lib/format";

export default async function DashboardPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;

  const [accounts, account, snapshot, positions, health, alertsPage] = await Promise.all([
    api.listAccounts(),
    api.getAccount(accountId),
    api.latestSnapshot(accountId),
    api.openPositions(accountId),
    api.health(),
    api.alerts(accountId, { limit: 5 }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={account.displayName ?? account.externalAccountId}
        right={<AccountSwitcher accounts={accounts} currentAccountId={accountId} basePath="/dashboard" />}
      />

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Account snapshot</h2>
        {snapshot ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <Tile label="Balance" value={formatMoney(snapshot.balance, account.currency)} />
            <Tile label="Equity" value={formatMoney(snapshot.equity, account.currency)} />
            <Tile label="Margin" value={formatMoney(snapshot.margin, account.currency)} />
            <Tile label="Free margin" value={formatMoney(snapshot.freeMargin, account.currency)} />
            <Tile
              label="Floating P/L"
              value={formatMoney(snapshot.profit, account.currency)}
              tone={Number(snapshot.profit) >= 0 ? "ok" : "down"}
            />
          </div>
        ) : (
          <EmptyState>No snapshot received from the collector yet.</EmptyState>
        )}
        {snapshot && (
          <p className="text-xs text-text-muted mt-2">
            Captured {formatRelative(snapshot.capturedAt)} · {formatDateTime(snapshot.capturedAt)}
          </p>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">System health</h2>
        <HealthTileRow health={health} />
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-text-muted">Open positions ({positions.length})</h2>
        </div>
        {positions.length === 0 ? (
          <EmptyState>No open positions right now.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-text-muted border-b border-border">
                <tr>
                  <th className="px-4 py-2.5">Symbol</th>
                  <th className="px-4 py-2.5">Side</th>
                  <th className="px-4 py-2.5">Volume</th>
                  <th className="px-4 py-2.5">Open price</th>
                  <th className="px-4 py-2.5">Current price</th>
                  <th className="px-4 py-2.5">P/L</th>
                  <th className="px-4 py-2.5">Opened</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 font-medium">{p.symbol}</td>
                    <td className="px-4 py-2.5">{p.side}</td>
                    <td className="px-4 py-2.5 font-mono">{formatNumber(p.volume)}</td>
                    <td className="px-4 py-2.5 font-mono">{formatNumber(p.openPrice, 5)}</td>
                    <td className="px-4 py-2.5 font-mono">{p.currentPrice ? formatNumber(p.currentPrice, 5) : "—"}</td>
                    <td className={`px-4 py-2.5 font-mono ${Number(p.profit) >= 0 ? "text-ok" : "text-down"}`}>
                      {formatMoney(p.profit, account.currency)}
                    </td>
                    <td className="px-4 py-2.5 text-text-muted">{formatRelative(p.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-text-muted">Recent alerts</h2>
          <Link href={`/alerts/${accountId}`} className="text-xs text-accent hover:underline">
            View all
          </Link>
        </div>
        {alertsPage.alerts.length === 0 ? (
          <EmptyState>No alerts have fired yet.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {alertsPage.alerts.map((alert) => (
              <li
                key={alert.id}
                className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3"
              >
                <div>
                  <p className="font-medium text-sm">{alert.rule.name}</p>
                  <p className="text-xs text-text-muted">{formatDateTime(alert.triggeredAt)}</p>
                </div>
                <StatusPill status={alert.delivery?.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
