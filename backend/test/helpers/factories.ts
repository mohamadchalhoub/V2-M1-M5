import { randomInt, randomUUID } from 'node:crypto';
import { Platform, PrismaClient } from '@prisma/client';
import { generateCollectorToken, generateDashboardToken, hashToken } from '../../src/auth/token.util';

export async function createUser(prisma: PrismaClient, email?: string) {
  return prisma.user.create({ data: { email: email ?? `trader-${randomUUID()}@example.com` } });
}

export async function createTradingAccount(
  prisma: PrismaClient,
  userId: string,
  overrides: Partial<{ externalAccountId: string; platform: Platform; currency: string }> = {},
) {
  return prisma.tradingAccount.create({
    data: {
      userId,
      platform: overrides.platform ?? 'MT5',
      externalAccountId: overrides.externalAccountId ?? randomUUID(),
      currency: overrides.currency ?? 'USD',
      displayName: 'Test Account',
    },
  });
}

// accountId is required (production-readiness review, item 1) — every
// collector token is bound to exactly one account now, matching
// CollectorTokenGuard's enforcement. Pass a different accountId than the
// one a request targets to exercise the cross-account-rejection path.
export async function createCollectorToken(prisma: PrismaClient, accountId: string, name = 'test-collector') {
  const { plaintext, prefix } = generateCollectorToken();
  const tokenHash = await hashToken(plaintext);
  const credential = await prisma.apiCredential.create({
    data: { name, tokenHash, tokenPrefix: prefix, scope: 'collector', accountId },
  });
  return { plaintext, credential };
}

/** The common case: one user, one MT5 account, one valid collector token bound to it. */
export async function setupAccountWithToken(prisma: PrismaClient) {
  const user = await createUser(prisma);
  const account = await createTradingAccount(prisma, user.id);
  const { plaintext: token } = await createCollectorToken(prisma, account.id);
  return { user, account, token };
}

// Dashboard authentication (production-readiness review — Option B) — same
// account-binding requirement and same "pass a different accountId to
// exercise the cross-account-rejection path" usage as createCollectorToken.
export async function createDashboardToken(prisma: PrismaClient, accountId: string, name = 'test-dashboard') {
  const { plaintext, prefix } = generateDashboardToken();
  const tokenHash = await hashToken(plaintext);
  const credential = await prisma.apiCredential.create({
    data: { name, tokenHash, tokenPrefix: prefix, scope: 'dashboard', accountId },
  });
  return { plaintext, credential };
}

/** One user, one account, one valid dashboard token bound to it. */
export async function setupAccountWithDashboardToken(
  prisma: PrismaClient,
  overrides: Partial<{ platform: Platform }> = {},
) {
  const user = await createUser(prisma);
  const account = await createTradingAccount(prisma, user.id, overrides);
  const { plaintext: token } = await createDashboardToken(prisma, account.id);
  return { user, account, token };
}

export function validSnapshotPayload(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId,
    capturedAt: new Date().toISOString(),
    balance: 1000,
    equity: 1000,
    margin: 0,
    freeMargin: 1000,
    profit: 0,
    terminal: { connected: true },
    collectorVersion: 'test-0.0.0',
    positions: [],
    ...overrides,
  };
}

export function validPositionPayload(overrides: Record<string, unknown> = {}) {
  return {
    externalPositionId: `pos-${randomInt(1_000_000_000)}`,
    symbol: 'EURUSD',
    side: 'BUY',
    volume: 0.1,
    openPrice: 1.1,
    profit: 0,
    swap: 0,
    openedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function validDealPayload(overrides: Record<string, unknown> = {}) {
  return {
    externalTradeId: String(randomInt(1_000_000_000)),
    symbol: 'EURUSD',
    side: 'SELL',
    dealEntry: 'OUT',
    volume: 0.1,
    price: 1.1,
    commission: 0,
    swap: 0,
    profit: 0,
    executedAt: new Date().toISOString(),
    ...overrides,
  };
}
