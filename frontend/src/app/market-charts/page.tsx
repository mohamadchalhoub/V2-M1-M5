import { api, type MarketDataCoverage } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { formatDateTime } from "@/lib/format";
import { PriceChart } from "./PriceChart";
import { SymbolPicker } from "./SymbolPicker";
import { TimeframePicker } from "./TimeframePicker";
import { DateRangeForm } from "./DateRangeForm";

const SYMBOLS = ["EURUSD", "XAUUSD"] as const;
type Symbol = (typeof SYMBOLS)[number];

const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

// Per-timeframe default lookback window (in days), applied whenever the URL
// doesn't already carry an explicit from/to. Mirrors the kind of
// per-timeframe sizing this project's backend already does with its own
// TIMEFRAME_LOOKBACK_DAYS-style constants: a small window for the highest-
// frequency timeframes (M1/M5) so the chart isn't asked to render an
// unreasonable number of bars by default, a much larger one for the
// coarsest (W1/MN1) so a handful of bars aren't shown in isolation. Not
// meant to match the backend's own numbers exactly — just sensible per
// timeframe, and comfortably under the backend's own
// MAX_CANDLES_PER_REQUEST (20,000) guard in every case.
const DEFAULT_LOOKBACK_DAYS: Record<Timeframe, number> = {
  M1: 1,
  M5: 3,
  M15: 7,
  M30: 14,
  H1: 30,
  H4: 90,
  D1: 365,
  W1: 3 * 365,
  MN1: 10 * 365,
};

function isSymbol(value: string | undefined): value is Symbol {
  return !!value && (SYMBOLS as readonly string[]).includes(value);
}

function isTimeframe(value: string | undefined): value is Timeframe {
  return !!value && (TIMEFRAMES as readonly string[]).includes(value);
}

// Pulled out of the page component: eslint's react-hooks/purity rule flags
// a component/hook body calling an impure function (Date.now/new Date())
// directly during render — same reasoning lib/format.ts's formatRelative
// already sidesteps by being a plain helper, not a component. This page IS
// deliberately impure (server-rendered per-request, reading "now" is the
// whole point), but keeping that call in an ordinary helper function keeps
// the lint rule (which only inspects component/hook bodies) satisfied
// without fighting the actual behavior.
function resolveRange(
  timeframe: Timeframe,
  fromParam: string | undefined,
  toParam: string | undefined,
): { from: string; to: string } {
  const now = Date.now();
  const defaultTo = new Date(now).toISOString();
  const defaultFrom = new Date(now - DEFAULT_LOOKBACK_DAYS[timeframe] * 24 * 60 * 60 * 1000).toISOString();
  const from = fromParam && !Number.isNaN(Date.parse(fromParam)) ? new Date(fromParam).toISOString() : defaultFrom;
  const to = toParam && !Number.isNaN(Date.parse(toParam)) ? new Date(toParam).toISOString() : defaultTo;
  return { from, to };
}

// Not account-scoped (no [accountId] segment) — browsing raw stored market
// data isn't tied to any one trading account. Same non-account-scoped shape
// as app/health/page.tsx, and same force-dynamic fix for the same latent
// build-time-prerender issue (this page reads searchParams and calls the
// backend on every request — it must never be statically prerendered).
export const dynamic = "force-dynamic";

export default async function MarketChartsPage({
  searchParams,
}: {
  searchParams: Promise<{ symbol?: string; timeframe?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const symbol: Symbol = isSymbol(params.symbol) ? params.symbol : "XAUUSD";
  const timeframe: Timeframe = isTimeframe(params.timeframe) ? params.timeframe : "H4";

  const { from, to } = resolveRange(timeframe, params.from, params.to);

  const [candlesResult, coverage] = await Promise.all([
    api.marketCandles(symbol, timeframe, from, to),
    api.marketCoverage(symbol),
  ]);

  const candles = candlesResult.candles;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Market data charts"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <SymbolPicker currentSymbol={symbol} timeframe={timeframe} from={params.from} to={params.to} />
            <TimeframePicker currentTimeframe={timeframe} symbol={symbol} from={params.from} to={params.to} />
          </div>
        }
      />

      <DateRangeForm symbol={symbol} timeframe={timeframe} from={from} to={to} />

      <div className="rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-text-muted">
        {symbol} · <span className="text-text font-medium">{timeframe}</span> — {formatDateTime(from)} →{" "}
        {formatDateTime(to)} ({candles.length} candle{candles.length === 1 ? "" : "s"})
      </div>

      {candles.length === 0 ? (
        <EmptyState>
          No data collected yet for {symbol} at {timeframe} in this range — see PROJECT status for backfill progress.
        </EmptyState>
      ) : (
        <div className="rounded-lg border border-border bg-surface px-2 py-2">
          <PriceChart candles={candles} symbol={symbol} timeframe={timeframe} />
        </div>
      )}

      <CoverageTable coverage={coverage} />
    </div>
  );
}

function CoverageTable({ coverage }: { coverage: MarketDataCoverage }) {
  return (
    <section>
      <h2 className="text-sm font-medium text-text-muted mb-3">Data coverage — {coverage.symbol}</h2>
      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-text-muted border-b border-border">
            <tr>
              <th className="px-4 py-2.5">Timeframe</th>
              <th className="px-4 py-2.5">Candles</th>
              <th className="px-4 py-2.5">Earliest</th>
              <th className="px-4 py-2.5">Latest</th>
            </tr>
          </thead>
          <tbody>
            {coverage.candles.map((row) => (
              <tr key={row.timeframe} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5 font-medium">{row.timeframe}</td>
                <td className="px-4 py-2.5">{row.count.toLocaleString()}</td>
                <td className="px-4 py-2.5 text-text-muted">{formatDateTime(row.earliest)}</td>
                <td className="px-4 py-2.5 text-text-muted">{formatDateTime(row.latest)}</td>
              </tr>
            ))}
            <tr className="last:border-0">
              <td className="px-4 py-2.5 font-medium">Ticks</td>
              <td className="px-4 py-2.5">{coverage.ticks.count.toLocaleString()}</td>
              <td className="px-4 py-2.5 text-text-muted">{formatDateTime(coverage.ticks.earliest)}</td>
              <td className="px-4 py-2.5 text-text-muted">{formatDateTime(coverage.ticks.latest)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-text-muted">
        Symbol metadata:{" "}
        {coverage.symbolMetadata.present
          ? `present (updated ${formatDateTime(coverage.symbolMetadata.updatedAt)})`
          : "not present"}
        .
      </p>
    </section>
  );
}
