import Link from "next/link";
import type { EurUsdRoundTrip } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";

export function TradeList({
  accountId,
  trips,
  selectedPositionId,
}: {
  accountId: string;
  trips: EurUsdRoundTrip[];
  selectedPositionId: string | undefined;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border text-xs uppercase tracking-wide text-text-muted">
        {trips.length} closed EURUSD trade{trips.length === 1 ? "" : "s"}
      </div>
      <div className="max-h-[560px] overflow-y-auto">
        {trips
          .slice()
          .reverse()
          .map((trip) => {
            const active = trip.positionId === selectedPositionId;
            return (
              <Link
                key={trip.positionId}
                href={`/eurusd-charts/${accountId}?position=${encodeURIComponent(trip.positionId)}`}
                className={`block px-4 py-2.5 border-b border-border last:border-0 text-sm ${
                  active ? "bg-accent-soft" : "hover:bg-surface/70"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={trip.side === "BUY" ? "text-ok font-medium" : "text-down font-medium"}>
                    {trip.side}
                  </span>
                  <span className={trip.profit >= 0 ? "text-ok" : "text-down"}>{formatNumber(trip.profit)}</span>
                </div>
                <div className="text-text-muted text-xs mt-0.5">{formatDateTime(trip.entryTime)}</div>
              </Link>
            );
          })}
      </div>
    </div>
  );
}
