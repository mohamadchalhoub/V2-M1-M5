-- CreateEnum
CREATE TYPE "MarketEventCategory" AS ENUM ('ECONOMIC_EVENT', 'NEWS');

-- AlterTable
ALTER TABLE "market_events" ADD COLUMN     "category" "MarketEventCategory" NOT NULL DEFAULT 'ECONOMIC_EVENT',
ADD COLUMN     "source_url" TEXT;

-- CreateIndex
CREATE INDEX "market_events_category_scheduled_at_idx" ON "market_events"("category", "scheduled_at");
