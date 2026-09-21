import { RuleRunState } from '@prisma/client';
import { CompoundParams } from '../dto/rule-parameters.dto';
import { ComponentStateMap, RuleComparisonOutcome, RuleEvaluationStatus } from '../types/rule-engine.types';

// RULE_ENGINE_SPEC.md §2.6 — flat AND/OR over components' already-persisted
// rule_state.state, never a re-evaluation of raw metrics. A component
// missing from the map (shouldn't happen once creation-time validation is
// in place, §1) defaults to INACTIVE rather than throwing, so a compound
// rule degrades safely instead of crashing an evaluation pass.
export function evaluateCompound(
  params: CompoundParams,
  componentStates: ComponentStateMap,
): RuleComparisonOutcome {
  const states = params.component_rule_ids.map((id) => componentStates.get(id) ?? RuleRunState.INACTIVE);
  const triggered =
    params.combinator === 'AND'
      ? states.every((s) => s === RuleRunState.ACTIVE)
      : states.some((s) => s === RuleRunState.ACTIVE);

  const componentStatesById: Record<string, RuleRunState> = {};
  params.component_rule_ids.forEach((id, i) => {
    componentStatesById[id] = states[i];
  });

  return {
    status: triggered ? RuleEvaluationStatus.TRIGGERED : RuleEvaluationStatus.NOT_TRIGGERED,
    reasonCode: triggered ? 'COMPOUND_SATISFIED' : 'COMPOUND_NOT_SATISFIED',
    triggerValues: { combinator: params.combinator, componentStates: componentStatesById },
    baselineValues: {},
  };
}
