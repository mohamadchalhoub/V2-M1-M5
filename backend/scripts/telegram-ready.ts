/**
 * Engine B pre-activation readiness, checked against the runtime rather than
 * against a configuration file.
 *
 * ## Why this replaced an HTTP probe
 *
 * The first version of `m1m5.sh telegram-ready` shelled into the `api`
 * container and `wget`-ed an authenticated dashboard endpoint on
 * `localhost:3000`. That was wrong in three separate ways, and it failed with
 * `Connection refused`:
 *
 *  1. it required `DASHBOARD_TOKEN` to be present in the api container, and
 *     the deployment never set that variable at all, so the request could
 *     only ever have been rejected even had it connected;
 *  2. it depended on the api container being up and healthy to answer a
 *     question about a DIFFERENT container's readiness — coupling the check
 *     to a service that has nothing to do with the answer;
 *  3. it turned a local state question into a network round trip, so a
 *     transient HTTP failure was indistinguishable from "not ready".
 *
 * A readiness check that can fail for reasons unrelated to readiness is worse
 * than no check, because it trains an operator to ignore it. This one reads
 * the same facts straight from the database and the filesystem, inside the
 * container that actually holds the session, with no HTTP and no token.
 *
 * Exit code 0 means every gate passed and Engine B may be enabled. Non-zero
 * means it may not, and says which gate.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { evaluateReadiness } from '../src/xauusd-m1m5/mt5-readiness';
import { M1M5Mt5SnapshotService } from '../src/xauusd-m1m5/mt5-snapshot.service';
import {
  configuredMaxAdverseEntryDeviationUsd,
  getTelegramExecutionMode,
  globalKillSwitchState,
  telegramEngineEnabled,
  telegramKillSwitchState,
} from '../src/telegram-engine/controls';
import { readStoredSession, sessionPermissionsOk } from '../src/telegram-engine/ingestion/session-store';
import { normaliseChannelId, displayChannelId } from '../src/telegram-engine/ingestion/channel-guard';
import { assertEngineSeparation } from '../src/telegram-engine/ownership';
import { TELEGRAM_MAGIC } from '../src/telegram-engine/safety-constants';
import { TELEGRAM_SPEC } from '../src/telegram-engine/spec';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** A failed advisory check reports but does not block activation. */
  readonly advisory?: boolean;
}

function render(checks: readonly Check[]): boolean {
  let blocking = false;
  for (const check of checks) {
    const mark = check.ok ? 'PASS' : check.advisory ? 'WARN' : 'FAIL';
    if (!check.ok && !check.advisory) blocking = true;
    console.log(`[${mark}] ${check.name}`);
    if (check.detail) console.log(`       ${check.detail}`);
  }
  return !blocking;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const checks: Check[] = [];

  const accountId = (
    process.env.TELEGRAM_ENGINE_ACCOUNT_ID ??
    process.env.XAUUSD_M1M5_ACCOUNT_ID ??
    process.env.COLLECTOR_ACCOUNT_ID ??
    ''
  ).trim();
  const expectedLoginId =
    (process.env.XAUUSD_M1M5_EXPECTED_LOGIN_ID ?? process.env.XAUUSD_M1M5_EXPECTED_LOGIN ?? '').trim() || null;

  console.log('ENGINE B — TELEGRAM CHANNEL — pre-activation readiness');
  console.log('');

  checks.push({
    name: 'Account configured',
    ok: accountId.length > 0,
    detail: accountId ? `account ${accountId}` : 'no account id; set XAUUSD_M1M5_ACCOUNT_ID',
  });

  // --- Magic-number separation. Cheap, and the consequence of getting it
  // wrong is Engine A's Friday liquidation closing Telegram positions.
  let separationOk = true;
  let separationDetail = `Telegram magic ${TELEGRAM_MAGIC} is disjoint from Engine A's`;
  try {
    assertEngineSeparation();
  } catch (err) {
    separationOk = false;
    separationDetail = (err as Error).message;
  }
  checks.push({ name: 'Engine magic numbers disjoint', ok: separationOk, detail: separationDetail });

  // --- Telegram session and source channel.
  const session = readStoredSession();
  checks.push({
    name: 'Telegram session present',
    ok: session !== null,
    detail: session
      ? `authorized ${session.authorizedAtMs ? new Date(session.authorizedAtMs).toISOString() : 'at an unknown time'}`
      : 'no session; run telegram-auth',
  });

  const perms = sessionPermissionsOk();
  checks.push({
    name: 'Session file permissions',
    ok: perms !== false,
    detail: perms === null ? 'not checkable on this platform' : perms ? 'owner-only (0600)' : 'NOT 0600 — fix with chmod 600',
    advisory: perms === null,
  });

  const configuredChannel = (process.env.TELEGRAM_INGEST_SOURCE_CHANNEL_ID ?? '').trim() || session?.sourceChannelId || null;
  checks.push({
    name: 'Source channel resolved',
    ok: configuredChannel !== null,
    detail: configuredChannel
      ? `@${TELEGRAM_SPEC.sourceChannelUsername} -> ${displayChannelId(normaliseChannelId(configuredChannel))}`
      : 'no channel id recorded; run telegram-auth',
  });

  // --- Has the channel actually delivered anything? This is what separates
  // "connected" from "receiving", and it is the check that would have caught
  // an account that resolved the channel without joining it.
  const lastIngested = await prisma.telegramIngestedMessage.findFirst({ orderBy: { receivedAt: 'desc' } });
  checks.push({
    name: 'Source messages observed',
    ok: lastIngested !== null,
    detail: lastIngested
      ? `last message ${lastIngested.receivedAt.toISOString()} (id ${lastIngested.messageId})`
      : 'no message has ever been received from the channel. If the channel is not simply quiet, the account ' +
        'may not be SUBSCRIBED — run telegram-check.',
    // Advisory: a genuinely quiet channel is not a reason to refuse
    // activation, and telegram-check answers the question definitively.
    advisory: true,
  });

  // --- MT5 readiness, from the collector's own snapshot.
  if (accountId) {
    const snapshots = new M1M5Mt5SnapshotService(prisma);
    const snapshot = await snapshots.latest(accountId);
    const readiness = evaluateReadiness({
      snapshot: snapshot?.permissions ?? null,
      expectedLoginId,
      nowMs: Date.now(),
    });
    checks.push({
      name: 'MT5 ready to trade',
      ok: readiness.ready,
      detail: readiness.ready
        ? `account ${snapshot?.permissions.loginId}, ${snapshot?.permissions.tradeMode}, hedging ${readiness.hedgingSupported}`
        : readiness.blockers.map((b) => `${b.code} (${b.origin})`).join(', '),
    });
    checks.push({
      name: 'DEMO account confirmed',
      ok: snapshot?.permissions.tradeMode === 'DEMO',
      detail: `trade mode: ${snapshot?.permissions.tradeMode ?? 'unknown'}`,
    });
    checks.push({
      name: 'Broker session state known',
      ok: snapshot?.sessionOpen !== null && snapshot?.sessionOpen !== undefined,
      detail:
        snapshot?.sessionOpen === true
          ? 'XAUUSD session open'
          : snapshot?.sessionOpen === false
            ? 'XAUUSD session CLOSED — signals will be consumed as TELEGRAM_MARKET_CLOSED until it reopens'
            : 'unknown, which blocks execution',
      // A closed market is a normal weekend state and not a reason to refuse
      // activation; it only means nothing will trade until it reopens.
      advisory: snapshot?.sessionOpen === false,
    });

    // --- Reconciliation. The one gate that cannot be satisfied by config.
    const recon = await prisma.telegramReconciliationState.findUnique({ where: { accountId } });
    checks.push({
      name: 'Reconciliation recoveryComplete',
      ok: recon?.recoveryComplete === true,
      detail: recon
        ? `${recon.recoveryComplete ? 'complete' : 'NOT complete'} — ${recon.detail ?? 'no detail'}`
        : 'no reconciliation pass has ever run. The collector must post a complete broker snapshot first ' +
          '(TELEGRAM_ENGINE_EXECUTION_ENABLED=true in collector/.env.production).',
    });

    const openLegs = await prisma.telegramSignalLeg.count({
      where: { signal: { accountId }, orderStatus: { in: ['PENDING', 'UNKNOWN'] } },
    });
    checks.push({
      name: 'No legs in an unresolved state',
      ok: openLegs === 0,
      detail: openLegs === 0 ? 'none' : `${openLegs} leg(s) PENDING or UNKNOWN`,
    });
  }

  // --- Controls, reported so the operator sees what activation will change.
  console.log('');
  console.log('Current Engine B configuration:');
  console.log(`  TELEGRAM_ENGINE_ENABLED         ${telegramEngineEnabled()}`);
  console.log(`  TELEGRAM_ENGINE_EXECUTION_MODE  ${getTelegramExecutionMode()}`);
  console.log(`  adverse entry bound             $${configuredMaxAdverseEntryDeviationUsd().toFixed(2)}`);
  console.log(`  volume per take profit          ${TELEGRAM_SPEC.lotsPerTakeProfit}`);
  console.log(`  signal lifetime                 ${TELEGRAM_SPEC.maxSignalAgeMs / 1000}s`);
  console.log(`  telegram kill switch            ${telegramKillSwitchState().active ? 'ENGAGED' : 'off'}`);
  console.log(`  global kill switch              ${globalKillSwitchState().active ? 'ENGAGED' : 'off'}`);
  console.log('');

  const ok = render(checks);
  console.log('');
  if (ok) {
    console.log('READY: every blocking gate passed. Engine B may be enabled.');
  } else {
    console.log('NOT READY: at least one blocking gate failed. Do not enable Engine B.');
  }
  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`telegram-ready failed: ${(err as Error).message}`);
  process.exit(1);
});
