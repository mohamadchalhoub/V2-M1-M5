import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { EmptyState } from "@/components/EmptyState";
import { Pagination } from "@/components/Pagination";
import { formatDateTime, formatMoney, formatNumber } from "@/lib/format";

const LIMIT = 50;

export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ offset?: string }>;
}) {
  const { accountId } = await params;
  const { offset: offsetParam } = await searchParams;
  const offset = Number(offsetParam) || 0;

  const [accounts, account, page] = await Promise.all([
    api.listAccounts(),
    api.getAccount(accountId),
    api.trades(accountId, { limit: LIMIT, offset }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Trade history"
        right={<AccountSwitcher accounts={accounts} currentAccountId={accountId} basePath="/history" />}
      />

      {page.trades.length === 0 ? (
        <EmptyState>No trades recorded for this account yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-text-muted border-b border-border">
              <tr>
                <th className="px-4 py-2.5">Executed</th>
                <th className="px-4 py-2.5">Engine</th>
                <th className="px-4 py-2.5">Frame</th>
                <th className="px-4 py-2.5">Symbol</th>
                <th className="px-4 py-2.5">Side</th>
                <th className="px-4 py-2.5">Leg</th>
                <th className="px-4 py-2.5">Volume</th>
                <th className="px-4 py-2.5">Price</th>
                <th className="px-4 py-2.5">P/L</th>
                <th className="px-4 py-2.5">Platform</th>
              </tr>
            </thead>
            <tbody>
              {page.trades.map((trade) => (
                <tr key={trade.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 text-text-muted whitespace-nowrap">{formatDateTime(trade.executedAt)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{trade.engine ?? "—"}</td>
                  <td className="px-4 py-2.5 font-mono">{trade.timeframe ?? "—"}</td>
                  <td className="px-4 py-2.5 font-medium">{trade.symbol}</td>
                  <td className="px-4 py-2.5">{trade.side}</td>
                  <td className="px-4 py-2.5 text-text-muted">{trade.dealEntry}</td>
                  <td className="px-4 py-2.5 font-mono">{formatNumber(trade.volume)}</td>
                  <td className="px-4 py-2.5 font-mono">{formatNumber(trade.price, 5)}</td>
                  <td className={`px-4 py-2.5 font-mono ${Number(trade.profit) >= 0 ? "text-ok" : "text-down"}`}>
                    {trade.dealEntry === "OUT" ? formatMoney(trade.profit, account.currency) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-text-muted">{trade.platform}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination basePath={`/history/${accountId}`} total={page.total} limit={page.limit} offset={page.offset} />
    </div>
  );
}
