import type { TradeChartWindow } from "@/lib/api";

function pct(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

export function TradeFeatures({ chart }: { chart: TradeChartWindow }) {
  const { preEntry, duringTrade, postExit } = chart.features;
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
      <div className="text-xs uppercase tracking-wide text-text-muted mb-2">
        Descriptive market context — historical statistics, not a prediction
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <div className="text-text-muted text-xs mb-1">Pre-entry ({preEntry.candleCount} candles)</div>
          <div>Return: {pct(preEntry.returnPct)}</div>
          <div>Volatility: {pct(preEntry.volatilityPct)}</div>
        </div>
        <div>
          <div className="text-text-muted text-xs mb-1">During trade ({duringTrade.candleCount} candles)</div>
          <div className="text-ok">MFE: {pct(duringTrade.maxFavorableExcursionPct)}</div>
          <div className="text-down">MAE: {pct(duringTrade.maxAdverseExcursionPct)}</div>
        </div>
        <div>
          <div className="text-text-muted text-xs mb-1">Post-exit ({postExit.candleCount} candles)</div>
          <div>Continuation: {pct(postExit.continuationPct)}</div>
        </div>
      </div>
      {chart.dataLimitation && (
        <div className="mt-3 text-xs text-down border-t border-border pt-2">⚠ {chart.dataLimitation}</div>
      )}
    </div>
  );
}
