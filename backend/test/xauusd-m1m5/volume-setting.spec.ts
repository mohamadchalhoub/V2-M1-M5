/**
 * Setting the volume, against a real database, with the broker's live values
 * as they were verified on the VPS (min 0.01, max 100, step 0.01, 100 oz/lot)
 * and the account's real $3,000 equity.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setVolume } from '../../src/xauusd-m1m5/volume-setting';
import { resolveVolume } from '../../src/xauusd-m1m5/volume';
import { V2_SYMBOL } from '../../src/xauusd-m1m5/safety-constants';
import { createTradingAccount, createUser } from '../helpers/factories';
import { resetDatabase } from '../helpers/db';

const prisma = new PrismaClient();
let accountId: string;

async function seedBroker() {
  await prisma.symbolMetadata.create({
    data: {
      symbol: V2_SYMBOL, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01,
      digits: 2, point: 0.01, contractSize: 100, profitCurrency: 'USD',
    },
  });
  await prisma.accountSnapshot.create({
    data: { accountId, balance: 3000, equity: 3000, margin: 0, freeMargin: 3000, profit: 0, capturedAt: new Date() },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  accountId = (await createTradingAccount(prisma, user.id)).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('setVolume', () => {
  it('sets 0.03 lot, which fits the 0.5% per-trade cap on $3,000', async () => {
    await seedBroker();

    const result = await setVolume(prisma, { accountId, lots: 0.03, changedBy: 'test' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // $5 stop x 100 oz x 0.03 lot = $15 = 0.5% of $3,000 -- exactly the cap.
    expect(result.stopRisk).toBeCloseTo(15, 9);
    expect(result.stopRiskPct).toBeCloseTo(0.5, 9);
    expect(result.aboveCap).toBe(false);
  });

  it('is what the execution path then reads', async () => {
    await seedBroker();
    await setVolume(prisma, { accountId, lots: 0.03, changedBy: 'test' });

    const row = await prisma.xauusdM1M5VolumeSetting.findUnique({ where: { accountId } });
    const resolved = resolveVolume(row ? Number(row.volumeLots) : null);

    expect(resolved.lots).toBe(0.03);
    expect(resolved.source).toBe('V2_EXPLICIT_SETTING');
  });

  it('writes an audit record of every change, including what it replaced', async () => {
    await seedBroker();
    await setVolume(prisma, { accountId, lots: 0.05, changedBy: 'alice', note: 'first' });
    await setVolume(prisma, { accountId, lots: 0.03, changedBy: 'bob', note: 'second' });

    const audits = await prisma.xauusdM1M5VolumeAudit.findMany({ where: { accountId }, orderBy: { changedAt: 'asc' } });

    expect(audits).toHaveLength(2);
    expect(audits[0]?.previousLots).toBeNull();
    expect(Number(audits[1]?.previousLots)).toBe(0.05);
    expect(Number(audits[1]?.newLots)).toBe(0.03);
    expect(audits[1]?.changedBy).toBe('bob');
    expect(audits[1]?.provenance).toContain('second');
  });

  it('warns, but does not refuse, a volume the risk gate will refuse', async () => {
    // The spec default: $250 at risk = 8.3% of $3,000. The risk gate is the
    // one that decides; this only says so.
    await seedBroker();

    const result = await setVolume(prisma, { accountId, lots: 0.5, changedBy: 'test' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aboveCap).toBe(true);
    expect(result.stopRiskPct).toBeCloseTo(8.333, 2);
  });

  it('refuses a volume off the broker step, and does not round it', async () => {
    await seedBroker();

    const result = await setVolume(prisma, { accountId, lots: 0.035, changedBy: 'test' });

    expect(result.ok).toBe(false);
    expect(await prisma.xauusdM1M5VolumeSetting.findUnique({ where: { accountId } })).toBeNull();
  });

  it('refuses a volume below the broker minimum', async () => {
    await seedBroker();
    const result = await setVolume(prisma, { accountId, lots: 0.001, changedBy: 'test' });
    expect(result.ok).toBe(false);
  });

  it('refuses zero, negative and non-numbers', async () => {
    await seedBroker();
    for (const lots of [0, -0.03, Number.NaN]) {
      expect((await setVolume(prisma, { accountId, lots, changedBy: 'test' })).ok).toBe(false);
    }
  });

  it('refuses to run without broker metadata, rather than skip validation', async () => {
    const result = await setVolume(prisma, { accountId, lots: 0.03, changedBy: 'test' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('metadata');
  });
});
