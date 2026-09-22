/**
 * The collector-facing request bodies, run through the application's REAL
 * validation pipe with the collector's real payload shapes.
 *
 * Why this exists: twice, a mismatch between what the collector sends and what
 * a DTO accepts has been fatal and silent.
 *
 *  1. The account snapshot carried a `permissions` block no DTO declared. With
 *     `forbidNonWhitelisted`, the backend rejected every snapshot — balance,
 *     positions and live tick — for as long as V2 had been deployed.
 *  2. This route declared `login` as a string while MT5 reports an integer.
 *     The pipe does no implicit conversion, so every permission report would
 *     have been rejected, readiness would have stayed NO_SNAPSHOT, and DEMO
 *     would never have placed an order — with nothing saying why.
 *
 * Unit tests on either side cannot see this; each side is internally correct.
 * Only running the actual pipe against the actual shape does. The options
 * below mirror `main.ts` exactly, and are asserted to, so this test cannot
 * drift into validating against a friendlier pipe than production uses.
 */
import { BadRequestException, ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  M1M5CloseResultDto,
  M1M5ExecutionResultDto,
  M1M5Mt5SnapshotDto,
} from '../../src/xauusd-m1m5/execution.controller';

const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true, transform: true };
const pipe = new ValidationPipe(PIPE_OPTIONS);

function meta(metatype: new () => unknown): ArgumentMetadata {
  return { type: 'body', metatype, data: '' };
}

async function accepts(metatype: new () => unknown, body: unknown): Promise<void> {
  await pipe.transform(body, meta(metatype));
}

async function rejectionOf(metatype: new () => unknown, body: unknown): Promise<string> {
  try {
    await pipe.transform(body, meta(metatype));
  } catch (err) {
    if (err instanceof BadRequestException) return JSON.stringify(err.getResponse());
    throw err;
  }
  throw new Error('expected the payload to be rejected, and it was accepted');
}

/** Exactly what `_push_m1m5_mt5_snapshot` sends, from build_permissions_payload. */
const COLLECTOR_MT5_SNAPSHOT = {
  login: '5056294252',
  server: 'MetaQuotes-Demo',
  tradeMode: 'DEMO',
  marginMode: 'RETAIL_HEDGING',
  terminalConnected: true,
  terminalTradeAllowed: true,
  terminalTradeApiDisabled: false,
  accountTradeAllowed: true,
  accountTradeExpert: true,
  capturedAt: '2026-09-22T00:30:00.000000+00:00',
  leverage: 100,
  sessionOpen: true,
};

describe('this test validates against the production pipe', () => {
  it('uses the same options as main.ts', () => {
    const mainTs = readFileSync(join(__dirname, '../../src/main.ts'), 'utf8');
    expect(mainTs).toMatch(/whitelist:\s*true/);
    expect(mainTs).toMatch(/forbidNonWhitelisted:\s*true/);
    expect(mainTs).toMatch(/transform:\s*true/);
    // If production ever turns this on, the "integer login" case below would
    // start passing, and this test should be revisited rather than trusted.
    expect(mainTs).not.toMatch(/enableImplicitConversion/);
  });
});

describe('mt5-snapshot', () => {
  it('accepts exactly what the collector sends', async () => {
    await expect(accepts(M1M5Mt5SnapshotDto, COLLECTOR_MT5_SNAPSHOT)).resolves.toBeUndefined();
  });

  it('accepts null for every permission, which is how "could not read" arrives', async () => {
    await expect(
      accepts(M1M5Mt5SnapshotDto, {
        capturedAt: COLLECTOR_MT5_SNAPSHOT.capturedAt,
        login: null,
        server: null,
        tradeMode: null,
        marginMode: null,
        terminalConnected: null,
        terminalTradeAllowed: null,
        terminalTradeApiDisabled: null,
        accountTradeAllowed: null,
        accountTradeExpert: null,
        leverage: null,
        sessionOpen: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('REJECTS an integer login -- why the collector stringifies it', async () => {
    const reason = await rejectionOf(M1M5Mt5SnapshotDto, { ...COLLECTOR_MT5_SNAPSHOT, login: 5056294252 });
    expect(reason).toContain('login');
  });

  it('rejects an undeclared field, as the account snapshot once did', async () => {
    const reason = await rejectionOf(M1M5Mt5SnapshotDto, { ...COLLECTOR_MT5_SNAPSHOT, permissions: {} });
    expect(reason).toContain('permissions');
  });
});

describe('pending-order result', () => {
  it('accepts a fill exactly as the collector reports it', async () => {
    await expect(
      accepts(M1M5ExecutionResultDto, {
        ok: true,
        uncertain: false,
        ticket: 58537207521,
        filledPrice: 4360.2,
        brokerStopLoss: 4365.2,
        brokerTakeProfit: 4355.2,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts the execution timeline exactly as the one-second pass reports it', async () => {
    await expect(
      accepts(M1M5ExecutionResultDto, {
        ok: true,
        uncertain: false,
        ticket: 58566028247,
        filledPrice: 4317.83,
        executionEvaluatedAt: '2026-09-22T08:41:44.101+00:00',
        submittedAt: '2026-09-22T08:41:44.180+00:00',
        acknowledgedAt: '2026-09-22T08:41:44.460+00:00',
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a not-sent refusal from the final check', async () => {
    await expect(
      accepts(M1M5ExecutionResultDto, {
        ok: false,
        uncertain: false,
        notSent: true,
        errorMessage: 'price has moved 150 points',
        executionEvaluatedAt: '2026-09-22T08:41:44.101+00:00',
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts an uncertain outcome with only an error message', async () => {
    await expect(
      accepts(M1M5ExecutionResultDto, { ok: false, uncertain: true, errorMessage: 'no response from broker' }),
    ).resolves.toBeUndefined();
  });
});

describe('close and protection results', () => {
  it('accepts an acceptance', async () => {
    await expect(accepts(M1M5CloseResultDto, { accepted: true })).resolves.toBeUndefined();
  });

  it('accepts a refusal with its reason', async () => {
    await expect(accepts(M1M5CloseResultDto, { accepted: false, errorMessage: 'market closed' })).resolves.toBeUndefined();
  });
});
