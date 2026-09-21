import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RuleType } from '@prisma/client';
import {
  CompoundParamsDto,
  ConcentrationParamsDto,
  ConsecutiveLossesParamsDto,
  DailyLossLimitParamsDto,
  DailyMarketAnalysisParamsDto,
  DrawdownParamsDto,
  HighImpactEventExposureParamsDto,
  IchimokuBreakoutParamsDto,
  MarginUtilizationParamsDto,
  NoStopLossParamsDto,
  PositionSizeMultipleParamsDto,
  SupportResistanceProximityParamsDto,
  TradeFrequencyMultipleParamsDto,
} from './rule-parameters.dto';

const PARAMS_CLASS_BY_TYPE: Record<RuleType, new () => object> = {
  DAILY_LOSS_LIMIT: DailyLossLimitParamsDto,
  DRAWDOWN: DrawdownParamsDto,
  CONSECUTIVE_LOSSES: ConsecutiveLossesParamsDto,
  POSITION_SIZE_MULTIPLE: PositionSizeMultipleParamsDto,
  TRADE_FREQUENCY_MULTIPLE: TradeFrequencyMultipleParamsDto,
  MARGIN_UTILIZATION: MarginUtilizationParamsDto,
  NO_STOP_LOSS: NoStopLossParamsDto,
  CONCENTRATION: ConcentrationParamsDto,
  HIGH_IMPACT_EVENT_EXPOSURE: HighImpactEventExposureParamsDto,
  COMPOUND: CompoundParamsDto,
  SUPPORT_RESISTANCE_PROXIMITY: SupportResistanceProximityParamsDto,
  ICHIMOKU_BREAKOUT: IchimokuBreakoutParamsDto,
  DAILY_MARKET_ANALYSIS: DailyMarketAnalysisParamsDto,
};

// Parameterless rule_types (RULE_ENGINE_SPEC.md §1 still gives each its own
// validated shape, but class-validator's forbidUnknownValues can't tell "a
// class with zero decorated fields" apart from "not a validatable object")
// — same special case NO_STOP_LOSS already needed, extended to the three
// technical-analysis rule types, which are parameterless for the same
// reason (RULE_ENGINE_SPEC.md addendum's own note: thresholds/timeframes
// for these live in system config, not per-rule parameters).
const PARAMETERLESS_RULE_TYPES: readonly RuleType[] = [
  RuleType.NO_STOP_LOSS,
  RuleType.SUPPORT_RESISTANCE_PROXIMITY,
  RuleType.ICHIMOKU_BREAKOUT,
  RuleType.DAILY_MARKET_ANALYSIS,
];

/**
 * Validates `parameters` against the fixed per-type shape (RULE_ENGINE_SPEC.md
 * §1). A malformed rule is rejected here, at creation/update time — never
 * discovered at evaluation time. `whitelist: true` also rejects any field not
 * in the type's own shape (e.g. accidentally sending both `count` and
 * `threshold_pct`), the same `forbidNonWhitelisted` posture the HTTP
 * ingestion DTOs already use.
 */
export function validateRuleParameters(ruleType: RuleType, parameters: unknown): void {
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    throw new BadRequestException(`parameters must be an object for rule_type ${ruleType}`);
  }

  if (PARAMETERLESS_RULE_TYPES.includes(ruleType)) {
    if (Object.keys(parameters as object).length > 0) {
      throw new BadRequestException(`rule_type ${ruleType} takes no parameters`);
    }
    return;
  }

  const dtoClass = PARAMS_CLASS_BY_TYPE[ruleType];
  const instance = plainToInstance(dtoClass, parameters, { excludeExtraneousValues: false });
  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });

  if (errors.length > 0) {
    const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    throw new BadRequestException(
      `Invalid parameters for rule_type ${ruleType}: ${messages.join('; ')}`,
    );
  }
}
