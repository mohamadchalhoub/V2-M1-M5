/**
 * Which engine, and which timeframe, a broker deal belongs to — derived from
 * the MT5 magic number, the same identity every engine stamps on its orders.
 *
 * Read-only use of each engine's constants: nothing here can affect either
 * engine's behaviour.
 */
import { AUTONOMOUS_MAGIC_NUMBER } from '../autonomous/safety-constants';
import { GOLD_MAGIC_NUMBER } from '../gold-execution/gold-safety-constants';
import { TELEGRAM_MAGIC } from '../telegram-engine/safety-constants';
import { V2_MAGIC_M1, V2_MAGIC_M5 } from '../xauusd-m1m5/safety-constants';

export type EngineLabel = 'Engine A' | 'Engine B' | 'Legacy' | 'Manual / other';
export type FrameLabel = 'M1' | 'M5' | null;

export interface EngineAttribution {
  readonly engine: EngineLabel;
  /** Only Engine A trades on a timeframe; Engine B copies Telegram signals. */
  readonly timeframe: FrameLabel;
  readonly magic: number | null;
}

export function attributeMagic(magic: number | null | undefined): EngineAttribution {
  const m = typeof magic === 'number' && Number.isFinite(magic) ? magic : null;
  if (m === V2_MAGIC_M1) return { engine: 'Engine A', timeframe: 'M1', magic: m };
  if (m === V2_MAGIC_M5) return { engine: 'Engine A', timeframe: 'M5', magic: m };
  if (m === TELEGRAM_MAGIC) return { engine: 'Engine B', timeframe: null, magic: m };
  if (m === AUTONOMOUS_MAGIC_NUMBER || m === GOLD_MAGIC_NUMBER) return { engine: 'Legacy', timeframe: null, magic: m };
  return { engine: 'Manual / other', timeframe: null, magic: m };
}

/** The MT5 magic carried in a stored deal's raw payload, if any. */
export function magicFromRawPayload(raw: unknown): number | null {
  if (raw && typeof raw === 'object' && 'magic' in raw) {
    const v = Number((raw as { magic: unknown }).magic);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

/**
 * Attribution for a deal, preferring the OPENING deal's magic when known: a
 * position closed manually or by the broker can carry magic 0 on its closing
 * deal, but the deal that opened it always carries the engine's magic.
 */
export function attributeDeal(ownRaw: unknown, openingRaw: unknown): EngineAttribution {
  const opening = magicFromRawPayload(openingRaw);
  if (opening !== null && opening !== 0) return attributeMagic(opening);
  return attributeMagic(magicFromRawPayload(ownRaw));
}
