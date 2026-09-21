import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { EmptyState } from "@/components/EmptyState";
import { formatDateTime } from "@/lib/format";
import { TradeChart } from "./TradeChart";
import { TradeFeatures } from "./TradeFeatures";
import { TradeList } from "./TradeList";

export default async function EurUsdChartsPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ position?: string }>;
}) {
  const { accountId } = await params;
  const { position } = await searchParams;

  const [accounts, trips] = await Promise.all([api.listAccounts(), api.eurUsdTrades(accountId)]);

  const selectedPositionId = position ?? trips[trips.length - 1]?.positionId;
  const chart = selectedPositionId ? await api.eurUsdTradeChart(accountId, selectedPositionId) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="EURUSD historical charts"
        right={<AccountSwitcher accounts={accounts} currentAccountId={accountId} basePath="/eurusd-charts" />}
      />

      {trips.length === 0 ? (
        <EmptyState>
          No closed EURUSD trades found for this account. Import a trade history (Imports tab) to see charts here.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-[280px_1fr] gap-6 items-start">
          <TradeList accountId={accountId} trips={trips} selectedPositionId={selectedPositionId} />
          <div className="flex flex-col gap-4">
            {chart ? (
              <>
                <div className="rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-text-muted">
                  Timeframe: <span className="text-text font-medium">{chart.timeframe}</span> — entry{" "}
                  {formatDateTime(chart.entryMarker.time)} → exit{" "}
                  {formatDateTime(chart.exitMarker.time)}
                </div>
                <div className="rounded-lg border border-border bg-surface px-2 py-2">
                  <TradeChart chart={chart} />
                </div>
                <TradeFeatures chart={chart} />
              </>
            ) : (
              <EmptyState>Select a trade to view its chart.</EmptyState>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
