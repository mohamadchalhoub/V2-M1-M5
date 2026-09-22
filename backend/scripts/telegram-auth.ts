/**
 * One-time interactive Telegram authorization for Engine B's ingestion.
 *
 * Run once per deployment, by a human, at a terminal:
 *
 *     bash deploy/m1m5.sh telegram-auth
 *
 * It signs a Telegram USER account in over MTProto, resolves `@SFxauusd1` to
 * its authoritative numeric id, verifies the channel is actually readable,
 * and writes the resulting session to the runtime volume with owner-only
 * permissions. After that, every restart reuses the stored session — there is
 * no second code prompt on a redeploy, a container recreation or a reboot.
 *
 * ## What it deliberately does not do
 *
 * It does not accept the phone number, the login code or the 2FA password
 * from a command-line argument, an environment variable or a file. Every one
 * of those leaves the secret somewhere it outlives the moment it was needed —
 * in shell history, in a process listing, in a committed file. They are read
 * interactively and used once. The 2FA password is read without echo.
 *
 * It does not print the API hash or the session string, and it does not join
 * the channel on the operator's behalf: if the account needs to subscribe,
 * that is reported as an instruction rather than performed, because
 * subscribing an account to a channel is a visible action on a real person's
 * Telegram profile and is theirs to take.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import {
  readStoredSession,
  sessionPermissionsOk,
  telegramSessionPath,
  writeStoredSession,
} from '../src/telegram-engine/ingestion/session-store';
import { displayChannelId, normaliseChannelId } from '../src/telegram-engine/ingestion/channel-guard';

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

/**
 * Reads a secret without echoing it.
 *
 * Node has no built-in "read a password", and the usual trick of muting
 * output has one sharp edge worth naming: if the process dies between muting
 * and restoring, the operator's terminal is left with echo off. The restore
 * therefore happens in a finally block and on the error path too.
 */
function askSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin as NodeJS.ReadStream & { isTTY?: boolean; setRawMode?: (v: boolean) => void };
    if (!input.isTTY) {
      // Not a terminal: refuse rather than reading a secret from a pipe,
      // which is how a password ends up in a log or a script.
      reject(new Error('A 2FA password must be typed at an interactive terminal, not piped in.'));
      return;
    }
    process.stdout.write(question);
    let value = '';
    const previouslyRaw = input.isRaw === true;
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');

    const done = (err: Error | null) => {
      input.setRawMode?.(previouslyRaw);
      input.pause();
      input.removeListener('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(null);
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    input.on('data', onData);
  });
}

async function main(): Promise<void> {
  const apiId = Number((process.env.TELEGRAM_INGEST_API_ID ?? '').trim());
  const apiHash = (process.env.TELEGRAM_INGEST_API_HASH ?? '').trim();
  const channelUsername = (process.env.TELEGRAM_INGEST_SOURCE_CHANNEL ?? 'SFxauusd1').trim().replace(/^@/, '');

  if (!Number.isFinite(apiId) || apiId <= 0 || apiHash.length === 0) {
    // Never echoes either value, including the one that is present.
    console.error('TELEGRAM_INGEST_API_ID and TELEGRAM_INGEST_API_HASH must both be set in the environment file.');
    process.exit(1);
  }

  console.log('Telegram ingestion authorization for Engine B (the Telegram copy engine).');
  console.log(`Source channel: @${channelUsername}`);
  console.log(`Session will be written to: ${telegramSessionPath()}`);
  console.log('');

  const existing = readStoredSession();
  if (existing) {
    console.log('A session is already stored. Re-authorizing replaces it.');
    const answer = (await ask('Continue and replace it? [y/N] ')).toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Left the existing session untouched.');
      return;
    }
  }

  const session = new StringSession(existing?.session ?? '');
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
  client.setLogLevel('error' as never);

  let phoneForLabel = '';
  await client.start({
    phoneNumber: async () => {
      phoneForLabel = await ask('Telegram phone number (international format, e.g. +9613xxxxxx): ');
      return phoneForLabel;
    },
    phoneCode: async () => ask('Login code Telegram just sent you: '),
    password: async () => askSecret('Two-factor password (not echoed): '),
    onError: (err) => {
      console.error(`Telegram sign-in error: ${err.message}`);
    },
  });

  const me = (await client.getMe()) as Api.User;
  const label = me.username ? `@${me.username}` : phoneForLabel || String(me.id);
  console.log(`Signed in as ${me.username ? '@' + me.username : 'the requested account'}.`);

  // --- Resolve the channel to its authoritative id.
  console.log(`Resolving @${channelUsername} ...`);
  let channelId: string | null = null;
  let channelTitle = '';
  let accessible = false;
  try {
    const entity = await client.getEntity(`@${channelUsername}`);
    if (entity instanceof Api.Channel) {
      channelId = normaliseChannelId(String(entity.id));
      channelTitle = entity.title;
      // Reading one message is the only proof that matters. An entity can be
      // resolved for a channel the account cannot actually read.
      const recent = await client.getMessages(entity, { limit: 1 });
      accessible = recent.length >= 0;
      console.log(`Resolved: "${channelTitle}" -> ${displayChannelId(channelId)}`);
      if (recent.length > 0 && recent[0]) {
        const when = recent[0].date ? new Date(recent[0].date * 1000).toISOString() : 'unknown time';
        console.log(`Most recent message in the channel is from ${when}.`);
      } else {
        console.log('The channel resolved but returned no messages.');
        console.log(`ACTION REQUIRED: open Telegram as this account and JOIN @${channelUsername}, then re-run this command.`);
        accessible = false;
      }
    } else {
      console.error(`@${channelUsername} resolved to something that is not a broadcast channel. Refusing to continue.`);
    }
  } catch (err) {
    console.error(`Could not resolve @${channelUsername}: ${(err as Error).message}`);
    console.error(`ACTION REQUIRED: open Telegram as this account, find @${channelUsername}, JOIN it, then re-run this command.`);
  }

  writeStoredSession({
    session: session.save(),
    authorizedAtMs: Date.now(),
    accountLabel: label,
    sourceChannelId: channelId,
    sourceChannelTitle: channelTitle || null,
  });

  await client.disconnect();

  console.log('');
  console.log(`Session written to ${telegramSessionPath()}`);
  const perms = sessionPermissionsOk();
  console.log(`File permissions owner-only: ${perms === null ? 'n/a on this platform' : perms ? 'yes (0600)' : 'NO - fix with chmod 600'}`);
  console.log('');
  if (channelId && accessible) {
    console.log('READY: the source channel is resolved and readable.');
    console.log(`Record this in backend/.env.production if you want it pinned explicitly:`);
    console.log(`  TELEGRAM_INGEST_SOURCE_CHANNEL_ID=${channelId}`);
    console.log('');
    console.log('Engine B stays in SHADOW until you enable execution deliberately.');
  } else {
    console.log('NOT READY: the session is saved, but the source channel is not confirmed readable.');
    console.log(`Join @${channelUsername} as this account and run this command again.`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`telegram-auth failed: ${(err as Error).message}`);
  process.exit(1);
});
