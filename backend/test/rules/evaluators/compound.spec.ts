import { RuleRunState } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { evaluateCompound } from '../../../src/rules/evaluators/compound.evaluator';
import { RuleEvaluationStatus } from '../../../src/rules/types/rule-engine.types';

describe('evaluateCompound', () => {
  it('AND — all components ACTIVE → TRIGGERED', () => {
    const states = new Map([
      ['a', RuleRunState.ACTIVE],
      ['b', RuleRunState.ACTIVE],
      ['c', RuleRunState.ACTIVE],
    ]);
    const result = evaluateCompound({ combinator: 'AND', component_rule_ids: ['a', 'b', 'c'] }, states);
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('AND — one component INACTIVE → NOT_TRIGGERED', () => {
    const states = new Map([
      ['a', RuleRunState.ACTIVE],
      ['b', RuleRunState.INACTIVE],
      ['c', RuleRunState.ACTIVE],
    ]);
    const result = evaluateCompound({ combinator: 'AND', component_rule_ids: ['a', 'b', 'c'] }, states);
    expect(result.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('OR — one component ACTIVE → TRIGGERED', () => {
    const states = new Map([
      ['a', RuleRunState.INACTIVE],
      ['b', RuleRunState.ACTIVE],
    ]);
    const result = evaluateCompound({ combinator: 'OR', component_rule_ids: ['a', 'b'] }, states);
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);
  });

  it('OR — all components INACTIVE → NOT_TRIGGERED', () => {
    const states = new Map([
      ['a', RuleRunState.INACTIVE],
      ['b', RuleRunState.INACTIVE],
    ]);
    const result = evaluateCompound({ combinator: 'OR', component_rule_ids: ['a', 'b'] }, states);
    expect(result.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('a component missing from the state map defaults to INACTIVE, never throws', () => {
    const states = new Map<string, RuleRunState>();
    const result = evaluateCompound({ combinator: 'OR', component_rule_ids: ['unknown'] }, states);
    expect(result.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });

  it('never returns INSUFFICIENT_DATA (no special case needed — RULE_ENGINE_SPEC.md §8)', () => {
    const result = evaluateCompound({ combinator: 'AND', component_rule_ids: ['x'] }, new Map());
    expect(result.status).not.toBe(RuleEvaluationStatus.INSUFFICIENT_DATA);
  });

  it('the three-rule "risk escalation" worked example (RULE_ENGINE_SPEC.md §2.6)', () => {
    const states = new Map([
      ['position-size', RuleRunState.ACTIVE],
      ['consecutive-losses', RuleRunState.ACTIVE],
      ['drawdown', RuleRunState.ACTIVE],
    ]);
    const result = evaluateCompound(
      { combinator: 'AND', component_rule_ids: ['position-size', 'consecutive-losses', 'drawdown'] },
      states,
    );
    expect(result.status).toBe(RuleEvaluationStatus.TRIGGERED);

    // Same three components, but the losing streak isn't active → AND must fail.
    states.set('consecutive-losses', RuleRunState.INACTIVE);
    const nonTrigger = evaluateCompound(
      { combinator: 'AND', component_rule_ids: ['position-size', 'consecutive-losses', 'drawdown'] },
      states,
    );
    expect(nonTrigger.status).toBe(RuleEvaluationStatus.NOT_TRIGGERED);
  });
});
