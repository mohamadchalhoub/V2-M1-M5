-- AlterEnum
ALTER TYPE "AutonomousDecisionSource" ADD VALUE 'AI_ASSISTED';

-- AlterTable
ALTER TABLE "autonomous_decisions" ADD COLUMN     "ai_model" TEXT,
ADD COLUMN     "ai_provider" TEXT,
ADD COLUMN     "ai_raw_response" JSONB,
ADD COLUMN     "ai_rejected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ai_rejection_reason" TEXT;
