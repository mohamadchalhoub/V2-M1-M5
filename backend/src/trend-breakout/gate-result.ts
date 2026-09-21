/** Shared by every gate-producing module (`signal-engine.ts`, `risk-policy.ts`, `entry-timing.ts`) so `TrendBreakoutDecision.gateResults` is always one consistent shape regardless of which layer produced an entry. */
export interface GateResult {
  gate: string;
  passed: boolean;
  reason: string;
}

export function passGate(gate: string, reason: string): GateResult {
  return { gate, passed: true, reason };
}

export function failGate(gate: string, reason: string): GateResult {
  return { gate, passed: false, reason };
}
