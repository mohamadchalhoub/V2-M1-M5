-- CreateEnum
CREATE TYPE "MarketEventScheduleType" AS ENUM ('EXPECTED', 'SURPRISE');

-- CreateEnum
CREATE TYPE "MarketEventImpact" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "MarketEventSentiment" AS ENUM ('POSITIVE', 'NEGATIVE', 'NEUTRAL', 'UNCERTAIN');

-- CreateTable
CREATE TABLE "market_events" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "schedule_type" "MarketEventScheduleType" NOT NULL,
    "impact" "MarketEventImpact" NOT NULL,
    "sentiment" "MarketEventSentiment" NOT NULL DEFAULT 'UNCERTAIN',
    "affected_currencies" TEXT[],
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "actual_reaction" JSONB,
    "raw_payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "market_events_scheduled_at_idx" ON "market_events"("scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "market_events_source_external_id_scheduled_at_key" ON "market_events"("source", "external_id", "scheduled_at");
