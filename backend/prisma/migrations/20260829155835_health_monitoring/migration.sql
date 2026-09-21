-- CreateEnum
CREATE TYPE "HealthComponent" AS ENUM ('COLLECTOR', 'MT5_TERMINAL', 'DATABASE', 'REDIS', 'TELEGRAM', 'AI_PROVIDER', 'XTB_IMPORT');

-- CreateEnum
CREATE TYPE "HealthStatusValue" AS ENUM ('OK', 'DEGRADED', 'DOWN');

-- CreateTable
CREATE TABLE "health_status" (
    "component" "HealthComponent" NOT NULL,
    "status" "HealthStatusValue" NOT NULL,
    "detail" JSONB,
    "checked_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "health_status_pkey" PRIMARY KEY ("component")
);

-- CreateTable
CREATE TABLE "health_incidents" (
    "id" TEXT NOT NULL,
    "component" "HealthComponent" NOT NULL,
    "status_from" "HealthStatusValue" NOT NULL,
    "status_to" "HealthStatusValue" NOT NULL,
    "detail" JSONB,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "health_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "health_incidents_component_opened_at_idx" ON "health_incidents"("component", "opened_at" DESC);
