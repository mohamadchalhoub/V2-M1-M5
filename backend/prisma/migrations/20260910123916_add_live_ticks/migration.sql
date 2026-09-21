-- CreateTable
CREATE TABLE "live_ticks" (
    "symbol" TEXT NOT NULL,
    "bid" DECIMAL(18,6) NOT NULL,
    "ask" DECIMAL(18,6) NOT NULL,
    "tick_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_ticks_pkey" PRIMARY KEY ("symbol")
);
