import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_RISK_POLICY, RiskPolicyConfig } from './risk-policy';

/**
 * §10 — "Implement these as explicit, versioned initial demo-policy
 * settings." Reads the currently `active` `TrendBreakoutRiskPolicy` row,
 * bootstrapping §10's own stated initial numbers (0.5% / 1% / 2% / 5% /
 * 10% / 5s) on first use. A policy CHANGE (not built into this session's
 * scope beyond the read path) would insert a new row and flip `active`,
 * never edit a row in place — every past decision's `riskPolicyVersion`
 * stays meaningful forever.
 */
@Injectable()
export class TrendBreakoutRiskPolicySettingsService {
  private readonly logger = new Logger(TrendBreakoutRiskPolicySettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getActive(): Promise<RiskPolicyConfig> {
    const existing = await this.prisma.trendBreakoutRiskPolicy.findFirst({ where: { active: true }, orderBy: { version: 'desc' } });
    if (existing) return toConfig(existing);

    const created = await this.prisma.trendBreakoutRiskPolicy.create({ data: { ...DEFAULT_RISK_POLICY, active: true } });
    this.logger.log(`bootstrapped initial risk policy v${created.version}: ${JSON.stringify(DEFAULT_RISK_POLICY)}`);
    return toConfig(created);
  }
}

function toConfig(row: {
  version: number;
  maxTradeRiskPct: { toNumber(): number };
  maxCombinedRiskPct: { toNumber(): number };
  dailyLossPct: { toNumber(): number };
  drawdownPct: { toNumber(): number };
  maxSpreadPctOfD: { toNumber(): number };
  maxQuoteAgeSeconds: number;
}): RiskPolicyConfig {
  return {
    version: row.version,
    maxTradeRiskPct: row.maxTradeRiskPct.toNumber(),
    maxCombinedRiskPct: row.maxCombinedRiskPct.toNumber(),
    dailyLossPct: row.dailyLossPct.toNumber(),
    drawdownPct: row.drawdownPct.toNumber(),
    maxSpreadPctOfD: row.maxSpreadPctOfD.toNumber(),
    maxQuoteAgeSeconds: row.maxQuoteAgeSeconds,
  };
}
