"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { TradeChartWindow } from "@/lib/api";

function toUtcTimestamp(iso: string): UTCTimestamp {
  return Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;
}

export function TradeChart({ chart }: { chart: TradeChartWindow }) {
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
      chart.candles.map((c) => ({
        time: toUtcTimestamp(c.openTime) as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    const markers: SeriesMarker<Time>[] = [
      {
        time: toUtcTimestamp(chart.entryMarker.time) as Time,
        position: chart.side === "BUY" ? "belowBar" : "aboveBar",
        color: chart.side === "BUY" ? "#16a34a" : "#dc2626",
        shape: chart.side === "BUY" ? "arrowUp" : "arrowDown",
        text: `${chart.side} @ ${chart.entryMarker.price}`,
      },
      {
        time: toUtcTimestamp(chart.exitMarker.time) as Time,
        position: chart.side === "BUY" ? "aboveBar" : "belowBar",
        color: chart.exitMarker.profit >= 0 ? "#16a34a" : "#dc2626",
        shape: chart.side === "BUY" ? "arrowDown" : "arrowUp",
        text: `EXIT @ ${chart.exitMarker.price}`,
      },
    ];
    createSeriesMarkers(series, markers);

    if (chart.stopLoss !== null) {
      series.createPriceLine({ price: chart.stopLoss, color: "#dc2626", lineStyle: 2, lineWidth: 1, title: "SL" });
    }
    if (chart.takeProfit !== null) {
      series.createPriceLine({ price: chart.takeProfit, color: "#16a34a", lineStyle: 2, lineWidth: 1, title: "TP" });
    }

    chartApi.timeScale().fitContent();

    return () => {
      chartApi.remove();
      chartApiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.positionId]);

  return <div ref={containerRef} className="w-full" />;
}
