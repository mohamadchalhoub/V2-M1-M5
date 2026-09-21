"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/api";

function toUtcTimestamp(iso: string): UTCTimestamp {
  return Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;
}

// Trimmed copy of eurusd-charts/[accountId]/TradeChart.tsx's chart-setup
// code: same createChart/addSeries/setData/fitContent/cleanup shape, same
// candle colors. No markers, no SL/TP price lines — this view browses raw
// stored history, there's no specific trade to annotate here.
export function PriceChart({
  candles,
  symbol,
  timeframe,
}: {
  candles: Candle[];
  symbol: string;
  timeframe: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chartApi = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#94a3b8" },
      grid: { vertLines: { color: "#1e293b" }, horzLines: { color: "#1e293b" } },
      timeScale: { timeVisible: true, secondsVisible: false },
      height: 480,
      autoSize: true,
    });
    chartApiRef.current = chartApi;

    const series = chartApi.addSeries(CandlestickSeries, {
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderVisible: false,
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
    });

    series.setData(
      candles.map((c) => ({
        time: toUtcTimestamp(c.openTime) as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    chartApi.timeScale().fitContent();

    return () => {
      chartApi.remove();
      chartApiRef.current = null;
    };
  }, [symbol, timeframe, candles]);

  return <div ref={containerRef} className="w-full" />;
}
