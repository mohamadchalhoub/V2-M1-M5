-- CreateEnum
CREATE TYPE "AiAnalysisStatus" AS ENUM ('PENDING', 'READY', 'WITHHELD', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "ai_analyses" (
    "id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "status" "AiAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "model" TEXT,
    "result" JSONB,
    "safety_flagged" BOOLEAN NOT NULL DEFAULT false,
    "flagged_pattern" TEXT,
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "telegram_message_ids" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_analyses_alert_id_key" ON "ai_analyses"("alert_id");

-- CreateIndex
CREATE INDEX "ai_analyses_status_created_at_idx" ON "ai_analyses"("status", "created_at");

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
