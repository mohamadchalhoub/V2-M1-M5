/**
 * Permanent CLI for managing trading-behavior rules — this is the tool for
 * configuring/changing rules until Phase 9's dashboard exists, not a
 * disposable test script. Lives alongside bootstrap.ts / create-collector-token.ts.
 *
 * Rules are account-specific by design (RULE_ENGINE_SPEC.md §1) — every
 * command operates on one account's rules and never touches another's, so
 * this same script is what a second trader on a second account would use
 * for their own configuration too (see the `accounts` command to find an
 * account id).
 *
 * Run with no arguments for full usage.
 */
import 'dotenv/config';
import { PrismaClient, RuleType } from '@prisma/client';
import { AccountsService } from '../src/accounts/accounts.service';
import { CreateRuleInput, RuleDefinitionsService, UpdateRuleInput } from '../src/rules/rule-definitions.service';
import { RuleStateService } from '../src/rules/rule-state.service';

const prisma = new PrismaClient();
const accounts = new AccountsService(prisma as any);
const ruleStates = new RuleStateService(prisma as any);
const ruleDefinitions = new RuleDefinitionsService(prisma as any, accounts, ruleStates);

const RULE_TYPES = Object.values(RuleType);

const USAGE = `
manage-rules — configure trading-behavior rules (no dashboard yet, this is it)

  npx tsx scripts/manage-rules.ts accounts
      List every trading account and its id.

  npx tsx scripts/manage-rules.ts list <accountId>
      List every rule for an account (enabled and disabled), with its
      current live state (ACTIVE/INACTIVE, cooldown).

  npx tsx scripts/manage-rules.ts show <ruleId>
      Full detail for one rule, plus its 5 most recent alerts.

  npx tsx scripts/manage-rules.ts create <accountId> <RULE_TYPE> [options]
  npx tsx scripts/manage-rules.ts update <ruleId> [options]
      Options:
        --name "..."              display name (create only, defaults to "<RULE_TYPE> rule")
        --param key=value         one parameter; repeat for more (see shapes below)
        --params '{"...":...}'    raw JSON parameters instead of --param
        --cooldown SECONDS        per-rule cooldown (default: 1800s / 30min)
        --disabled                create the rule disabled (create only)

  npx tsx scripts/manage-rules.ts enable <ruleId>
  npx tsx scripts/manage-rules.ts disable <ruleId>
      Disabling also resets the rule's live state, so it can never leave a
      stale reading behind for a COMPOUND rule that references it.

RULE TYPES & PARAMETERS (RULE_ENGINE_SPEC.md §2):

  DAILY_LOSS_LIMIT          --param threshold_pct=0.05
      Trading-day loss reaches 5% of the day's starting balance.

  DRAWDOWN                  --param threshold_pct=0.03
      Current equity drawdown from the all-time peak reaches 3%.

  CONSECUTIVE_LOSSES        --param count=4
      Current losing streak reaches 4 trades in a row.

  POSITION_SIZE_MULTIPLE    --param factor=2 --param baseline=avg
      An open position is >= 2x the account's average (or "max") historical
      position size. baseline must be "avg" or "max".

  TRADE_FREQUENCY_MULTIPLE  --param factor=3 --param window_minutes=60
      Trades in the trailing 60 minutes reach 3x the historical average for
      a window that size.

  MARGIN_UTILIZATION       --param min_margin_level_pct=150
      Margin level drops to/below 150% WHILE margin is actually in use
      (never triggers on an idle account with nothing open).

  NO_STOP_LOSS              (no parameters)
      At least one open position has no stop-loss set. A monitoring
      warning, not trading advice.

  CONCENTRATION             --param threshold_pct=0.7
      Open exposure concentrated >= 70% in one symbol OR one direction
      (all-BUY/all-SELL). Does not attempt cross-instrument correlation.

  HIGH_IMPACT_EVENT_EXPOSURE --param minutes_before=30 --param minimum_exposure_volume=1
      Open-position volume in a currency affected by an upcoming HIGH-impact
      economic release (market-events module, FRED) reaches 1 lot within 30
      minutes of that release. Requires MARKET_EVENTS_ENABLED=true and a
      populated market_events table to ever have upcoming events to check.

  COMPOUND                  --param combinator=AND --param component_rule_ids=<id1>,<id2>,<id3>
      Fires only when all (AND) or any (OR) of the listed rules are
      currently ACTIVE. Components must be non-COMPOUND rules on the SAME
      account — create them first, then reference their ids here.

EXAMPLES:

  npx tsx scripts/manage-rules.ts create 82cd5b46-... DRAWDOWN \\
      --name "3% drawdown guard" --param threshold_pct=0.03

  npx tsx scripts/manage-rules.ts update 3f9a2b1c-... --param threshold_pct=0.05 --cooldown 3600

  npx tsx scripts/manage-rules.ts disable 3f9a2b1c-...
`;

interface Flags {
  [key: string]: string[];
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'disabled') {
        flags[key] = [...(flags[key] ?? []), 'true'];
        continue;
      }
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${key} requires a value`);
      flags[key] = [...(flags[key] ?? []), value];
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function coerceValue(key: string, raw: string): unknown {
  if (key === 'component_rule_ids') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

function parseParams(flags: Flags): Record<string, unknown> | undefined {
  if (flags.params) return JSON.parse(flags.params[0]);
  if (!flags.param) return undefined;
  const result: Record<string, unknown> = {};
  for (const kv of flags.param) {
    const idx = kv.indexOf('=');
    if (idx === -1) throw new Error(`--param must be key=value, got "${kv}"`);
    const key = kv.slice(0, idx);
    result[key] = coerceValue(key, kv.slice(idx + 1));
  }
  return result;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width - 1) + ' ' : value.padEnd(width);
}

async function cmdAccounts(): Promise<void> {
  const rows = await prisma.tradingAccount.findMany({ include: { user: true }, orderBy: { createdAt: 'asc' } });
  if (rows.length === 0) {
    console.log('No trading accounts yet — run `npm run bootstrap` first.');
    return;
  }
  console.log(pad('ACCOUNT ID', 38) + pad('PLATFORM', 6) + pad('LOGIN', 14) + pad('DISPLAY NAME', 28) + 'OWNER');
  for (const a of rows) {
    console.log(
      pad(a.id, 38) + pad(a.platform, 6) + pad(a.externalAccountId, 14) + pad(a.displayName ?? '-', 28) + a.user.email,
    );
  }
}

async function cmdList(accountId: string): Promise<void> {
  await accounts.getOrThrow(accountId);
  const rules = await ruleDefinitions.findAllForAccount(accountId);
  if (rules.length === 0) {
    console.log('No rules configured for this account yet — use `create` to add one.');
    return;
  }
  for (const rule of rules) {
    const state = await ruleStates.get(rule.id);
    const cooling = state?.cooldownUntil && state.cooldownUntil > new Date();
    console.log(`\n${rule.enabled ? '●' : '○'} ${rule.name}  [${rule.ruleType}]`);
    console.log(`  id: ${rule.id}`);
    console.log(`  parameters: ${JSON.stringify(rule.parameters)}`);
    console.log(`  cooldown: ${rule.cooldownSeconds ?? 'default (1800s)'}`);
    console.log(`  state: ${state?.state ?? 'INACTIVE'}${cooling ? ` (re-notify after ${state!.cooldownUntil!.toISOString()})` : ''}`);
  }
  console.log('');
}

async function cmdShow(ruleId: string): Promise<void> {
  const rule = await ruleDefinitions.getOrThrow(ruleId);
  const state = await ruleStates.get(ruleId);
  const alerts = await prisma.alert.findMany({
    where: { ruleId },
    orderBy: { triggeredAt: 'desc' },
    take: 5,
    include: { delivery: true },
  });

  console.log(`${rule.name}  [${rule.ruleType}]  ${rule.enabled ? 'enabled' : 'disabled'}`);
  console.log(`id: ${rule.id}`);
  console.log(`account: ${rule.accountId}`);
  console.log(`parameters: ${JSON.stringify(rule.parameters, null, 2)}`);
  console.log(`cooldown: ${rule.cooldownSeconds ?? 'default (1800s)'}`);
  console.log(`state: ${JSON.stringify(state, null, 2)}`);
  console.log(`\nrecent alerts (${alerts.length}):`);
  for (const a of alerts) {
    console.log(`  ${a.triggeredAt.toISOString()}  delivery=${a.delivery?.status ?? 'none'}  ${JSON.stringify(a.triggerValues)}`);
  }
}

async function cmdCreate(accountId: string, ruleTypeRaw: string, flags: Flags): Promise<void> {
  const ruleType = ruleTypeRaw.toUpperCase() as RuleType;
  if (!RULE_TYPES.includes(ruleType)) {
    throw new Error(`Unknown rule type "${ruleTypeRaw}". Valid types: ${RULE_TYPES.join(', ')}`);
  }
  let parameters = parseParams(flags);
  if (!parameters && ruleType === RuleType.NO_STOP_LOSS) {
    // The one parameterless rule type — nothing to require.
    parameters = {};
  }
  if (!parameters) {
    throw new Error('Provide parameters with --param key=value (repeatable) or --params \'{"...":...}\'');
  }

  const input: CreateRuleInput = {
    name: flags.name?.[0] ?? `${ruleType} rule`,
    ruleType,
    parameters,
    enabled: !flags.disabled,
    cooldownSeconds: flags.cooldown ? Number(flags.cooldown[0]) : null,
  };

  const rule = await ruleDefinitions.create(accountId, input);
  console.log(`created rule ${rule.id} ("${rule.name}") for account ${accountId}`);
}

async function cmdUpdate(ruleId: string, flags: Flags): Promise<void> {
  const input: UpdateRuleInput = {};
  if (flags.name) input.name = flags.name[0];
  const parameters = parseParams(flags);
  if (parameters) input.parameters = parameters;
  if (flags.cooldown) input.cooldownSeconds = Number(flags.cooldown[0]);

  if (Object.keys(input).length === 0) {
    throw new Error('Nothing to update — pass --name, --param/--params, and/or --cooldown');
  }

  const rule = await ruleDefinitions.update(ruleId, input);
  console.log(`updated rule ${rule.id} ("${rule.name}")`);
}

async function cmdSetEnabled(ruleId: string, enabled: boolean): Promise<void> {
  const rule = await ruleDefinitions.setEnabled(ruleId, enabled);
  console.log(`${enabled ? 'enabled' : 'disabled'} rule ${rule.id} ("${rule.name}")`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case 'accounts':
      return cmdAccounts();
    case 'list':
      if (!positional[0]) throw new Error('usage: list <accountId>');
      return cmdList(positional[0]);
    case 'show':
      if (!positional[0]) throw new Error('usage: show <ruleId>');
      return cmdShow(positional[0]);
    case 'create':
      if (!positional[0] || !positional[1]) throw new Error('usage: create <accountId> <RULE_TYPE> [options]');
      return cmdCreate(positional[0], positional[1], flags);
    case 'update':
      if (!positional[0]) throw new Error('usage: update <ruleId> [options]');
      return cmdUpdate(positional[0], flags);
    case 'enable':
      if (!positional[0]) throw new Error('usage: enable <ruleId>');
      return cmdSetEnabled(positional[0], true);
    case 'disable':
      if (!positional[0]) throw new Error('usage: disable <ruleId>');
      return cmdSetEnabled(positional[0], false);
    default:
      console.log(USAGE);
      throw new Error(`Unknown command "${command}"`);
  }
}

main()
  .catch((err) => {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
