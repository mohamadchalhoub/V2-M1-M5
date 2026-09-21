-- CreateEnum
CREATE TYPE "BackfillDataType" AS ENUM ('CANDLE', 'TICK');

-- CreateEnum
CREATE TYPE "BackfillIntervalStatus" AS ENUM ('PENDING', 'COMPLETED', 'EMPTY_UNCONFIRMED', 'EMPTY_CONFIRMED', 'FAILED', 'INCOMPLETE', 'SUSPECTED_TRUNCATED');

-- AlterEnum
ALTER TYPE "CandleTimeframe" ADD VALUE 'M1';

-- AlterTable
ALTER TABLE "historical_candles" ADD COLUMN     "broker_symbol" TEXT,
ADD COLUMN     "feed_id" TEXT,
ADD COLUMN     "real_volume" DECIMAL(18,2),
ADD COLUMN     "server" TEXT,
ADD COLUMN     "spread" INTEGER;

-- AlterTable
ALTER TABLE "symbol_metadata" ADD COLUMN     "broker_symbol" TEXT,
ADD COLUMN     "currency_base" TEXT,
ADD COLUMN     "currency_margin" TEXT,
ADD COLUMN     "currency_profit" TEXT,
ADD COLUMN     "expiration_mode" INTEGER,
ADD COLUMN     "expiration_time" TIMESTAMP(3),
ADD COLUMN     "path" TEXT,
ADD COLUMN     "server" TEXT,
ADD COLUMN     "swap_long" DECIMAL(18,6),
ADD COLUMN     "swap_mode" INTEGER,
ADD COLUMN     "swap_rollover_3_days" INTEGER,
ADD COLUMN     "swap_short" DECIMAL(18,6),
ADD COLUMN     "trade_freeze_level" INTEGER,
ADD COLUMN     "trade_mode" INTEGER,
ADD COLUMN     "trade_stops_level" INTEGER,
ADD COLUMN     "trade_tick_size" DECIMAL(18,8),
ADD COLUMN     "trade_tick_value" DECIMAL(18,8);

-- CreateTable
CREATE TABLE "historical_ticks" (
    "id" BIGSERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "broker_symbol" TEXT,
    "server" TEXT,
    "feed_id" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "bid" DECIMAL(18,6) NOT NULL,
    "ask" DECIMAL(18,6) NOT NULL,
    "last" DECIMAL(18,6),
    "volume" DECIMAL(18,2),
    "volume_real" DECIMAL(18,2),
    "flags" INTEGER NOT NULL,
    "batch_seq" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MT5',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_ticks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backfill_intervals" (
    "id" BIGSERIAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MT5',
    "symbol" TEXT NOT NULL,
    "broker_symbol" TEXT,
    "server" TEXT,
    "data_type" "BackfillDataType" NOT NULL,
    "timeframe" "CandleTimeframe",
    "timeframe_key" TEXT NOT NULL,
    "range_start" TIMESTAMP(3) NOT NULL,
    "range_end" TIMESTAMP(3) NOT NULL,
    "status" "BackfillIntervalStatus" NOT NULL DEFAULT 'PENDING',
    "record_count" INTEGER,
    "evidence" TEXT,
    "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "backfill_intervals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "historical_ticks_symbol_timestamp_idx" ON "historical_ticks"("symbol", "timestamp");

-- CreateIndex
CREATE INDEX "backfill_intervals_symbol_data_type_timeframe_status_idx" ON "backfill_intervals"("symbol", "data_type", "timeframe", "status");

-- CreateIndex
CREATE UNIQUE INDEX "backfill_intervals_source_symbol_data_type_timeframe_key_ra_key" ON "backfill_intervals"("source", "symbol", "data_type", "timeframe_key", "range_start", "range_end");

-- Tick identity: an EXPRESSION unique index over every broker-given field,
-- not a plain @@unique (Prisma's schema DSL has no expression-index
-- syntax) — see HistoricalTick's own schema comment for the full
-- reasoning. COALESCE sentinels make NULL last/volume/volume_real compare
-- equal to themselves across an overlap re-fetch, which a plain unique
-- index on nullable columns would NOT do (Postgres treats NULL <> NULL
-- even inside a unique index). Verified directly against this project's
-- own Postgres before adding here (a companion attempt using an enum-to-
-- text CAST for BackfillInterval failed migration validation with
-- "functions in index expression must be marked IMMUTABLE" — Postgres's
-- enum-to-text cast is STABLE, not IMMUTABLE; none of the types used below
-- are enums, so this one is unaffected and was confirmed to apply cleanly).
-- This backs an atomic `INSERT ... ON CONFLICT (<same expression list>)
-- DO NOTHING`, safe under concurrent/repeated batch pushes — unlike a
-- check-then-insert `WHERE NOT EXISTS`, which races.
CREATE UNIQUE INDEX "historical_ticks_identity_key" ON "historical_ticks" (
    "symbol",
    COALESCE("broker_symbol", ''),
    "timestamp",
    "bid",
    "ask",
    COALESCE("last", -1),
    COALESCE("volume", -1),
    COALESCE("volume_real", -1),
    "flags"
);
