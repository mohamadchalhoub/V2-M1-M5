-- Engine B — the Telegram copy engine (`telegram-sfxauusd1-copy-v1`).
--
-- Additive only. No existing table, column, index or constraint is touched,
-- so the RSI M1/M5 engine's state semantics are unchanged by this migration.
--
-- The two unique constraints below are the duplicate guarantee, and they are
-- in the DATABASE rather than in application memory on purpose: an in-memory
-- guard survives a redelivered update and a reconnect but not a restart, and a
-- restart mid-signal is exactly when a second set of positions would be opened.

-- CreateEnum
CREATE TYPE "TelegramEngineDirection" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "TelegramLegOrderStatus" AS ENUM ('NONE', 'PENDING', 'FILLED', 'FAILED', 'UNKNOWN', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TelegramGroupState" AS ENUM ('RESERVED', 'SENT', 'FILLED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "telegram_signals" (
    "id" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "account_id" TEXT,
    "symbol" TEXT NOT NULL DEFAULT 'XAUUSD',
    "channel_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "semantic_key" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "raw_text" TEXT NOT NULL,
    "direction" "TelegramEngineDirection",
    "entry" DECIMAL(18,6),
    "stop_loss" DECIMAL(18,6),
    "take_profits" DECIMAL(18,6)[],
    "outcome" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "executable_price" DECIMAL(18,6),
    "deviation_usd" DECIMAL(18,6),
    "evidence" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_signal_legs" (
    "id" TEXT NOT NULL,
    "signal_id" TEXT NOT NULL,
    "leg_index" INTEGER NOT NULL,
    "direction" "TelegramEngineDirection" NOT NULL,
    "volume_lots" DECIMAL(18,6) NOT NULL,
    "source_entry" DECIMAL(18,6) NOT NULL,
    "stop_loss" DECIMAL(18,6) NOT NULL,
    "take_profit" DECIMAL(18,6) NOT NULL,
    "magic_number" INTEGER NOT NULL,
    "ticket" BIGINT,
    "position_id" TEXT,
    "order_status" "TelegramLegOrderStatus" NOT NULL DEFAULT 'NONE',
    "skip_reason" TEXT,
    "age_at_submission_ms" INTEGER,
    "sent_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "filled_at" TIMESTAMP(3),
    "fill_price" DECIMAL(18,6),
    "broker_stop_loss" DECIMAL(18,6),
    "broker_take_profit" DECIMAL(18,6),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_signal_legs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_signal_group_locks" (
    "account_id" TEXT NOT NULL,
    "signal_id" TEXT NOT NULL,
    "state" "TelegramGroupState" NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_signal_group_locks_pkey" PRIMARY KEY ("account_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_signals_account_id_engine_version_source_key_key" ON "telegram_signals"("account_id", "engine_version", "source_key");

-- CreateIndex
CREATE INDEX "telegram_signals_account_id_semantic_key_published_at_idx" ON "telegram_signals"("account_id", "semantic_key", "published_at");

-- CreateIndex
CREATE INDEX "telegram_signals_account_id_published_at_idx" ON "telegram_signals"("account_id", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_signal_legs_signal_id_leg_index_key" ON "telegram_signal_legs"("signal_id", "leg_index");

-- CreateIndex
CREATE INDEX "telegram_signal_legs_order_status_idx" ON "telegram_signal_legs"("order_status");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_signal_group_locks_signal_id_key" ON "telegram_signal_group_locks"("signal_id");

-- AddForeignKey
ALTER TABLE "telegram_signal_legs" ADD CONSTRAINT "telegram_signal_legs_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "telegram_signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_signal_group_locks" ADD CONSTRAINT "telegram_signal_group_locks_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "telegram_signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
