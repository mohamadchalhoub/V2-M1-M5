-- CreateEnum
CREATE TYPE "CandleTimeframe" AS ENUM ('M5', 'M15', 'H1');

-- CreateTable
CREATE TABLE "historical_candles" (
    "id" BIGSERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" "CandleTimeframe" NOT NULL,
    "open_time" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(18,6) NOT NULL,
    "high" DECIMAL(18,6) NOT NULL,
    "low" DECIMAL(18,6) NOT NULL,
    "close" DECIMAL(18,6) NOT NULL,
    "volume" DECIMAL(18,2),
    "source" TEXT NOT NULL DEFAULT 'MT5',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_candles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "historical_candles_symbol_timeframe_open_time_idx" ON "historical_candles"("symbol", "timeframe", "open_time" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "historical_candles_symbol_timeframe_open_time_key" ON "historical_candles"("symbol", "timeframe", "open_time");
