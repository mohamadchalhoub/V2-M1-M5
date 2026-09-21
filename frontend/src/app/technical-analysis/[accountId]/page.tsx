import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { EmptyState } from "@/components/EmptyState";
import { formatDateTime } from "@/lib/format";

const BIAS_STYLE: Record<string, string> = {
  BULLISH: "bg-ok-soft text-ok",
  BEARISH: "bg-down-soft text-down",
  NEUTRAL: "bg-border/60 text-text-muted",
};

const POSITION_STYLE: Record<string, string> = {
  ABOVE_CLOUD: "bg-ok-soft text-ok",
  BELOW_CLOUD: "bg-down-soft text-down",
  INSIDE_CLOUD: "bg-warn-soft text-warn",
  INSUFFICIENT_DATA: "bg-border/60 text-text-muted",
};

function Pill({ label, style }: { label: string; style: string }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium tracking-wide ${style}`}>{label}</span>;
}

export default async function TechnicalAnalysisPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const [accounts, report] = await Promise.all([api.listAccounts(), api.technicalAnalysis(accountId)]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="EURUSD technical analysis"
        right={<AccountSwitcher accounts={accounts} currentAccountId={accountId} basePath="/technical-analysis" />}
      />

      <p className="text-sm text-text-muted -mt-4">
        Deterministic support/resistance, Ichimoku, and Fibonacci analysis — historical statistics, not a prediction.
      </p>

      {!report ? (
        <EmptyState>No EURUSD candle data available yet.</EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="rounded-lg border border-border bg-surface px-4 py-3.5">
            <p className="text-xs text-text-muted">Current EURUSD price</p>
            <p className="text-2xl font-semibold font-mono">{report.currentPrice.toFixed(5)}</p>
          </div>

          <section className="rounded-lg border border-border bg-surface px-4 py-3.5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium">Market direction</h2>
              <Pill label={report.marketDirection.dailyBias} style={BIAS_STYLE[report.marketDirection.dailyBias]} />
            </div>
            <p className="text-xs text-text-muted mb-2">Confidence: {Math.round(report.marketDirection.confidence * 100)}%</p>
            <ul className="text-xs flex flex-col gap-1">
              {report.marketDirection.reasons.map((reason, i) => (
                <li key={i} className="text-text-muted">• {reason}</li>
              ))}
            </ul>
          </section>

          <section className="rounded-lg border border-border bg-surface px-4 py-3.5">
            <h2 className="text-sm font-medium mb-3">Support and resistance</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {report.supportResistance.map((sr) => (
                <div key={sr.timeframe} className="flex flex-col gap-1 text-xs">
                  <p className="font-medium">{sr.timeframe}</p>
                  <p className="text-text-muted">
                    Resistance: <span className="font-mono text-text">{sr.nearestResistance ? sr.nearestResistance.price.toFixed(5) : "—"}</span>
                  </p>
                  <p className="text-text-muted">
                    Support: <span className="font-mono text-text">{sr.nearestSupport ? sr.nearestSupport.price.toFixed(5) : "—"}</span>
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-surface px-4 py-3.5">
            <h2 className="text-sm font-medium mb-3">Ichimoku</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {report.ichimoku.map((state) => (
                <div key={state.timeframe} className="flex flex-col gap-1.5 text-xs">
                  <p className="font-medium">{state.timeframe}</p>
                  <Pill label={state.position} style={POSITION_STYLE[state.position]} />
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-surface px-4 py-3.5">
            <h2 className="text-sm font-medium mb-3">Fibonacci (daily swing)</h2>
            {!report.fibonacci ? (
              <p className="text-xs text-text-muted">Not enough recent data to identify a swing.</p>
            ) : (
              <div className="text-xs flex flex-col gap-1">
                <p className="text-text-muted">
                  Swing ({report.fibonacci.direction}): high{" "}
                  <span className="font-mono text-text">{report.fibonacci.swingHigh.price.toFixed(5)}</span> / low{" "}
                  <span className="font-mono text-text">{report.fibonacci.swingLow.price.toFixed(5)}</span>
                </p>
                <p className="text-text-muted">
                  Nearest level: {(report.fibonacci.nearestLevel.ratio * 100).toFixed(1)}% at{" "}
                  <span className="font-mono text-text">{report.fibonacci.nearestLevel.price.toFixed(5)}</span>
                </p>
              </div>
            )}
          </section>

          <p className="text-xs text-text-muted">Last computed: {formatDateTime(report.timestamp)}</p>
        </div>
      )}
    </div>
  );
}
