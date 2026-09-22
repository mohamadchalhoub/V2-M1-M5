-- The MT5 permission snapshot the collector reports.
--
-- One row per account, overwritten in place: this is current state rather than
-- a history. Every permission column is NULLABLE on purpose -- NULL means "the
-- collector could not read this", a third state distinct from false, and the
-- backend treats it as a blocker rather than collapsing it either way.

-- CreateTable
CREATE TABLE "xauusd_m1m5_mt5_snapshots" (
    "account_id" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "login_id" TEXT,
    "server" TEXT,
    "trade_mode" TEXT,
    "margin_mode" TEXT,
    "terminal_connected" BOOLEAN,
    "terminal_trade_allowed" BOOLEAN,
    "terminal_trade_api_disabled" BOOLEAN,
    "account_trade_allowed" BOOLEAN,
    "account_trade_expert" BOOLEAN,
    "leverage" INTEGER,
    "session_open" BOOLEAN,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xauusd_m1m5_mt5_snapshots_pkey" PRIMARY KEY ("account_id")
);

-- AddForeignKey
ALTER TABLE "xauusd_m1m5_mt5_snapshots" ADD CONSTRAINT "xauusd_m1m5_mt5_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
