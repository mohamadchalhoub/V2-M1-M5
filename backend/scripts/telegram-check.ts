/**
 * Is the source channel actually going to deliver us messages?
 *
 * This exists because "connected, no messages" has two explanations that look
 * identical from the outside and need opposite responses:
 *
 *   the channel is quiet   — nothing to do, wait.
 *   we are not subscribed  — Telegram pushes real-time updates only for
 *                            channels the account has JOINED. A public
 *                            channel can be READ without joining, so the
 *                            authentication check passing is not evidence
 *                            that updates will arrive. Without a join, the
 *                            engine sits connected and silent forever.
 *
 * So this asks the question directly: is this account a member, and what has
 * the channel published recently? Comparing the channel's own last message
 * time against our ingestion log answers "should we have seen something by
 * now?" with a fact rather than a guess.
 *
 * It also doubles as SHADOW validation: it runs the real parser over the real
 * recent messages and prints what the engine would have made of each one,
 * without touching the database or placing anything.
 */
import 'dotenv/config';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { readStoredSession, telegramSessionPath } from '../src/telegram-engine/ingestion/session-store';
import { displayChannelId, normaliseChannelId } from '../src/telegram-engine/ingestion/channel-guard';
import { parseTelegramSignal } from '../src/telegram-engine/parser';
import { firstTarget } from '../src/telegram-engine/tp1';

const HOW_MANY = Number((process.env.TELEGRAM_CHECK_MESSAGES ?? '10').trim()) || 10;

async function main(): Promise<void> {
  const apiId = Number((process.env.TELEGRAM_INGEST_API_ID ?? '').trim());
  const apiHash = (process.env.TELEGRAM_INGEST_API_HASH ?? '').trim();
  const username = (process.env.TELEGRAM_INGEST_SOURCE_CHANNEL ?? 'SFxauusd1').trim().replace(/^@/, '');

  if (!Number.isFinite(apiId) || apiId <= 0 || apiHash.length === 0) {
    console.error('TELEGRAM_INGEST_API_ID and TELEGRAM_INGEST_API_HASH must both be set.');
    process.exit(1);
  }
  const stored = readStoredSession();
  if (!stored) {
    console.error(`No Telegram session at ${telegramSessionPath()}. Run telegram-auth first.`);
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(stored.session), apiId, apiHash, { connectionRetries: 3 });
  client.setLogLevel('error' as never);
  await client.connect();

  if (!(await client.isUserAuthorized())) {
    console.error('The stored session is not authorized. Run telegram-auth again.');
    await client.disconnect();
    process.exit(2);
  }

  const entity = await client.getEntity(`@${username}`);
  if (!(entity instanceof Api.Channel)) {
    console.error(`@${username} is not a broadcast channel. Refusing to go further.`);
    await client.disconnect();
    process.exit(2);
  }

  const resolvedId = normaliseChannelId(String(entity.id));
  console.log(`Channel:        ${entity.title}`);
  console.log(`Numeric id:     ${displayChannelId(resolvedId)}  (stored: ${stored.sourceChannelId ?? 'none'})`);
  if (stored.sourceChannelId && normaliseChannelId(stored.sourceChannelId) !== resolvedId) {
    console.log('');
    console.log('MISMATCH: the channel this username now resolves to is NOT the one recorded at authentication.');
    console.log('Every message will be refused by the channel guard until this is resolved deliberately.');
  }

  // --- The membership question, which is the whole point of this script.
  //
  // `left` is Telegram's own flag for "this account is not a participant".
  // A public channel resolves and reads fine while left === true, and sends
  // us no updates at all.
  const joined = entity.left === false;
  console.log(`Subscribed:     ${joined ? 'YES' : 'NO'}`);
  if (!joined) {
    console.log('');
    console.log('=========================================================================');
    console.log('ACTION REQUIRED — the engine will receive NOTHING until this is fixed.');
    console.log('');
    console.log(`Open Telegram as this account, go to @${username}, and press JOIN.`);
    console.log('');
    console.log('Telegram delivers real-time channel updates only to subscribers. The');
    console.log('channel is readable without joining, which is why authentication');
    console.log('succeeded, but no new message will ever be pushed to this session.');
    console.log('=========================================================================');
  }

  // --- What has the channel actually published? This is what distinguishes
  // "quiet channel" from "we are not receiving".
  const messages = await client.getMessages(entity, { limit: HOW_MANY });
  console.log('');
  if (messages.length === 0) {
    console.log('The channel returned no messages at all.');
  } else {
    const newest = messages[0];
    const newestAt = newest?.date ? new Date(newest.date * 1000) : null;
    console.log(
      `Channel's last message: ${newestAt ? newestAt.toISOString() : 'unknown'}` +
        (newestAt ? `  (${Math.round((Date.now() - newestAt.getTime()) / 60_000)} minutes ago)` : ''),
    );
    console.log('');
    console.log(`Last ${messages.length} message(s), through the real parser:`);
    console.log('');
    for (const message of messages) {
      const when = message.date ? new Date(message.date * 1000).toISOString() : 'unknown';
      const text = typeof message.message === 'string' ? message.message : '';
      const oneLine = text.replace(/\s+/g, ' ').slice(0, 70);
      const parsed = parseTelegramSignal(text);
      if (parsed.signal) {
        const s = parsed.signal;
        console.log(`  [${message.id}] ${when}`);
        console.log(`      SIGNAL: ${s.direction} entry ${s.entry} SL ${s.stopLoss} TP ${s.takeProfits.join('/')}`);
        console.log(`      TP1 ${firstTarget(s.direction, s.takeProfits)} -> ${s.takeProfits.length} leg(s) of 0.01`);
      } else {
        console.log(`  [${message.id}] ${when}`);
        console.log(`      ignored (${parsed.refusal}): "${oneLine}"`);
      }
    }
  }

  console.log('');
  console.log('Nothing was executed, queued or written by this check.');
  await client.disconnect();
}

main().catch((err) => {
  console.error(`telegram-check failed: ${(err as Error).message}`);
  process.exit(1);
});
