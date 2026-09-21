import { HealthStatusValue } from '@prisma/client';
import IORedis from 'ioredis';
import { AiConfig } from '../ai/ai.config';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotClient } from '../telegram/telegram-bot.client';

export interface ComponentCheckResult {
  status: HealthStatusValue;
  detail: Record<string, unknown> | null;
}

/** A trivial round-trip query — the whole point is "can we reach Postgres and get an answer," not measuring anything about the schema. */
export async function checkDatabase(prisma: PrismaService): Promise<ComponentCheckResult> {
  await prisma.$queryRaw`SELECT 1`;
  return { status: 'OK', detail: null };
}

export async function checkRedis(connection: IORedis): Promise<ComponentCheckResult> {
  const pong = await connection.ping();
  return { status: pong === 'PONG' ? 'OK' : 'DEGRADED', detail: pong === 'PONG' ? null : { reply: pong } };
}

/**
 * COLLECTOR and MT5_TERMINAL share one query (both read `collector_heartbeats`,
 * HEALTH_SPEC.md §3) but are genuinely different signals: COLLECTOR asks "is
 * the Windows box still pushing data at all," MT5_TERMINAL asks "is the
 * terminal it's reading from actually connected" — a collector that's up but
 * whose MT5 login dropped is COLLECTOR:OK, MT5_TERMINAL:DOWN, not conflated
 * (Phase 0 §14). No accounts configured yet is DEGRADED, not DOWN or OK —
 * there is genuinely nothing to report, which is a different fact from
 * "everything's fine" or "everything's broken."
 */
export async function checkCollectorAndMt5(
  prisma: PrismaService,
  staleThresholdSeconds: number,
): Promise<{ collector: ComponentCheckResult; mt5: ComponentCheckResult }> {
  const heartbeats = await prisma.collectorHeartbeat.findMany({
    select: { accountId: true, lastHeartbeatAt: true, mt5Connected: true, lastError: true },
  });

  if (heartbeats.length === 0) {
    const detail = { reason: 'no collector heartbeat received yet' };
    return { collector: { status: 'DEGRADED', detail }, mt5: { status: 'DEGRADED', detail } };
  }

  const now = Date.now();
  const staleMs = staleThresholdSeconds * 1000;
  const stale = heartbeats.filter((h) => now - h.lastHeartbeatAt.getTime() > staleMs);
  const disconnected = heartbeats.filter((h) => !h.mt5Connected);

  const collectorStatus: HealthStatusValue =
    stale.length === heartbeats.length ? 'DOWN' : stale.length > 0 ? 'DEGRADED' : 'OK';
  const mt5Status: HealthStatusValue =
    disconnected.length === heartbeats.length ? 'DOWN' : disconnected.length > 0 ? 'DEGRADED' : 'OK';

  return {
    collector: { status: collectorStatus, detail: { accounts: heartbeats.length, stale: stale.length } },
    mt5: {
      status: mt5Status,
      detail: { accounts: heartbeats.length, disconnected: disconnected.length },
    },
  };
}

// A consecutive-DEAD-deliveries streak, on the same lookback/threshold
// pattern as checkAiProvider below — getMe reachability alone can't see this:
// the bot token can be valid and api.telegram.org reachable right now while
// every actual delivery over the past N attempts still ended DEAD (exhausted
// retries), which getMe would never surface. Same "don't degrade on a single
// blip" reasoning applies: a lone DEAD amid recent SENTs is a transient
// failure the retry mechanism already handled, not a health signal.
const TELEGRAM_LOOKBACK_COUNT = 10;
const TELEGRAM_DEGRADED_AFTER = 2; // consecutive DEAD
const TELEGRAM_DOWN_AFTER = 5;

// Reliability pass — a lone getMe timeout/network blip must not flip this
// straight to DOWN, same "don't degrade on a single blip" reasoning the
// consecutive-DEAD-streak check below already applies to deliveries (found
// live this session: 15 OK->DOWN->OK flaps in ~90 minutes, each
// self-resolving by the very next 60s-later tick — a real but transient
// network hiccup on this end, not Telegram or the bot token actually being
// down). One quick retry, close together, catches that within the SAME
// check tick rather than waiting up to another full interval to recover.
const CONNECTIVITY_RETRY_DELAY_MS = 2000;

/**
 * getMe costs nothing and sends no message — a pure reachability probe
 * (telegram-bot.client.ts) — but only proves the bot token/API path works,
 * not that recent real deliveries have actually succeeded. Combined here
 * with a consecutive-DEAD-streak check over the most recent terminal
 * `AlertDelivery` outcomes (SENT/DEAD — PENDING/FAILED are still retrying,
 * not terminal), so a run of silent delivery failures shows up even while
 * getMe itself stays OK.
 */
export async function checkTelegram(botClient: TelegramBotClient, prisma: PrismaService): Promise<ComponentCheckResult> {
  let ok = await botClient.checkConnectivity();
  if (!ok) {
    await new Promise((resolve) => setTimeout(resolve, CONNECTIVITY_RETRY_DELAY_MS));
    ok = await botClient.checkConnectivity();
  }
  if (!ok) {
    return { status: 'DOWN', detail: { reason: 'Telegram getMe unreachable (failed twice)' } };
  }

  const recent = await prisma.alertDelivery.findMany({
    where: { status: { in: ['SENT', 'DEAD'] } },
    orderBy: { updatedAt: 'desc' },
    take: TELEGRAM_LOOKBACK_COUNT,
    select: { status: true },
  });

  let consecutiveDead = 0;
  for (const row of recent) {
    if (row.status !== 'DEAD') break;
    consecutiveDead += 1;
  }

  if (consecutiveDead >= TELEGRAM_DOWN_AFTER) {
    return { status: 'DOWN', detail: { reason: 'consecutive delivery failures', consecutiveDead } };
  }
  if (consecutiveDead >= TELEGRAM_DEGRADED_AFTER) {
    return { status: 'DEGRADED', detail: { reason: 'consecutive delivery failures', consecutiveDead } };
  }
  return { status: 'OK', detail: null };
}

/**
 * Deliberately does NOT make a real (paid) Anthropic call just to answer a
 * health check — proxies via the last hour's AiAnalysis outcomes instead
 * (PHASE5_DELIVERY_SPEC.md §11's same idea, applied to `ai`). AI_ENABLED=false
 * is reported OK — "off" is not a failure state.
 */
const AI_LOOKBACK_COUNT = 10;
const AI_DEGRADED_AFTER = 2; // consecutive failures
const AI_DOWN_AFTER = 5;

/**
 * "Consecutive failure count from ai_analyses; degraded after N in a row,
 * not on a single blip" (Phase 0 §13's own component-detection table) — a
 * single flaky call must never flip this to DEGRADED, only a genuine run of
 * them. Looks at the most recent `AI_LOOKBACK_COUNT` terminal analyses
 * (READY or FAILED — PENDING/WITHHELD/SKIPPED aren't provider-health
 * signals) and counts the consecutive FAILED streak from the newest one
 * backward, stopping at the first READY.
 */
export async function checkAiProvider(prisma: PrismaService, aiConfig: AiConfig): Promise<ComponentCheckResult> {
  if (!aiConfig.enabled) {
    return { status: 'OK', detail: { enabled: false } };
  }

  const recent = await prisma.aiAnalysis.findMany({
    where: { status: { in: ['READY', 'FAILED'] } },
    orderBy: { updatedAt: 'desc' },
    take: AI_LOOKBACK_COUNT,
    select: { status: true },
  });

  let consecutiveFailures = 0;
  for (const row of recent) {
    if (row.status !== 'FAILED') break;
    consecutiveFailures += 1;
  }

  if (consecutiveFailures >= AI_DOWN_AFTER) {
    return { status: 'DOWN', detail: { consecutiveFailures } };
  }
  if (consecutiveFailures >= AI_DEGRADED_AFTER) {
    return { status: 'DEGRADED', detail: { consecutiveFailures } };
  }
  return { status: 'OK', detail: { enabled: true, consecutiveFailures } };
}

/**
 * Event-driven signal, not a poll of live state (Phase 0 §13: "the importer
 * itself flags a failed import_batches row directly") — there is no ongoing
 * process to ping between imports, so this only looks at the outcome of the
 * most recent batch across all accounts. No batch ever run is OK ("nothing
 * to report" is not a failure); the latest batch having failed is DOWN,
 * since it means the last file a user uploaded did not import.
 */
export async function checkXtbImport(prisma: PrismaService): Promise<ComponentCheckResult> {
  const latest = await prisma.importBatch.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { status: true, accountId: true, fileName: true, error: true, createdAt: true },
  });

  if (!latest) {
    return { status: 'OK', detail: { note: 'no import activity to evaluate yet' } };
  }
  if (latest.status === 'FAILED') {
    return {
      status: 'DOWN',
      detail: { accountId: latest.accountId, fileName: latest.fileName, error: latest.error },
    };
  }
  return { status: 'OK', detail: { accountId: latest.accountId, fileName: latest.fileName } };
}
