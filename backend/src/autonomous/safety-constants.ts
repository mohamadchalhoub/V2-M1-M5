/**
 * Absolute, non-negotiable safety bounds (AUTONOMOUS_DEMO_TRADING_PLAN.md
 * §1) — hardcoded compile-time constants, deliberately NOT `.env` config,
 * because §1 is explicit that these must never be something a config value
 * could edit. Shared by `validate-autonomous-ai-decision.ts` and
 * `risk-manager.ts` so both independent layers enforce the exact same
 * numbers rather than each hardcoding its own copy that could drift.
 */
export const SAFETY_SYMBOL = 'EURUSD';
export const MAX_POSITION_SIZE_LOTS = 0.01;
/** Fixed, arbitrary MT5 magic number — distinguishes this system's own orders from any manual trading or other EA on the same demo account. Never sourced from a decision row or any other input. */
export const AUTONOMOUS_MAGIC_NUMBER = 262610180;
/** How far a computed value may drift from its exact expected number before being rejected — generous enough for ordinary floating-point noise, nowhere near enough to matter to the trade's actual risk. */
export const SL_TP_TOLERANCE_POINTS = 0.5;
