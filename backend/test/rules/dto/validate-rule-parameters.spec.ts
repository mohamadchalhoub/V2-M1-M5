import { RuleType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { validateRuleParameters } from '../../../src/rules/dto/validate-rule-parameters';

describe('validateRuleParameters', () => {
  it('accepts valid MARGIN_UTILIZATION parameters', () => {
    expect(() =>
      validateRuleParameters(RuleType.MARGIN_UTILIZATION, { min_margin_level_pct: 150 }),
    ).not.toThrow();
  });

  it('rejects a negative MARGIN_UTILIZATION threshold', () => {
    expect(() =>
      validateRuleParameters(RuleType.MARGIN_UTILIZATION, { min_margin_level_pct: -1 }),
    ).toThrow(/Invalid parameters/);
  });

  it('accepts valid CONCENTRATION parameters', () => {
    expect(() => validateRuleParameters(RuleType.CONCENTRATION, { threshold_pct: 0.7 })).not.toThrow();
  });

  it('rejects a CONCENTRATION threshold above 1 (must be a 0-1 fraction)', () => {
    expect(() => validateRuleParameters(RuleType.CONCENTRATION, { threshold_pct: 70 })).toThrow(/Invalid parameters/);
  });

  // Regression: NO_STOP_LOSS's DTO has zero decorated properties, which
  // trips class-validator's own forbidUnknownValues safeguard if routed
  // through the generic class-validator path — validateRuleParameters
  // handles it directly instead (see that function's own comment).
  it('accepts an empty object for the parameterless NO_STOP_LOSS rule_type', () => {
    expect(() => validateRuleParameters(RuleType.NO_STOP_LOSS, {})).not.toThrow();
  });

  it('rejects any field at all for NO_STOP_LOSS', () => {
    expect(() => validateRuleParameters(RuleType.NO_STOP_LOSS, { anything: 1 })).toThrow(
      /takes no parameters/,
    );
  });

  it('still rejects a non-object parameters value for every rule_type, NO_STOP_LOSS included', () => {
    expect(() => validateRuleParameters(RuleType.NO_STOP_LOSS, null)).toThrow(/must be an object/);
    expect(() => validateRuleParameters(RuleType.DRAWDOWN, 'not-an-object')).toThrow(/must be an object/);
  });

  it('still rejects an unknown field for existing rule types (forbidNonWhitelisted unaffected)', () => {
    expect(() =>
      validateRuleParameters(RuleType.DRAWDOWN, { threshold_pct: 0.03, extra_field: 1 }),
    ).toThrow(/Invalid parameters/);
  });

  // The three technical-analysis rule types (user's custom EURUSD trading
  // rules) are parameterless for the same reason NO_STOP_LOSS is — their
  // thresholds/timeframes live in system config, not per-rule parameters.
  it.each([RuleType.SUPPORT_RESISTANCE_PROXIMITY, RuleType.ICHIMOKU_BREAKOUT, RuleType.DAILY_MARKET_ANALYSIS])(
    'accepts an empty object for the parameterless %s rule_type',
    (ruleType) => {
      expect(() => validateRuleParameters(ruleType, {})).not.toThrow();
    },
  );

  it.each([RuleType.SUPPORT_RESISTANCE_PROXIMITY, RuleType.ICHIMOKU_BREAKOUT, RuleType.DAILY_MARKET_ANALYSIS])(
    'rejects any field at all for %s',
    (ruleType) => {
      expect(() => validateRuleParameters(ruleType, { anything: 1 })).toThrow(/takes no parameters/);
    },
  );
});
