/**
 * Who owns a Telegram-engine position (Engine B).
 *
 * The mandatory property this file exists to hold up, in both directions:
 *
 * - Engine A must never close a Telegram position merely because it exists in
 *   the same account. Engine A guarantees that itself, by selecting only its
 *   own magic numbers; `assertEngineSeparation` proves the two registries
 *   cannot overlap, so that guarantee cannot quietly lapse.
 * - Engine B must never close an Engine A position, a manual trade or another
 *   bot's position. Anything whose magic is not `TELEGRAM_MAGIC` is foreign
 *   to Engine B, and foreign is the default for anything unrecognised.
 */
import {
  V2_MAGIC_M1,
  V2_MAGIC_M5,
} from '../xauusd-m1m5/safety-constants';
import { TELEGRAM_MAGIC, TELEGRAM_FOREIGN_MAGIC_NUMBERS } from './safety-constants';
import { TELEGRAM_ENGINE_VERSION } from './spec';

export interface TelegramPositionOwner {
  readonly magicNumber: number;
  readonly engineVersion: string;
  readonly label: string;
  readonly managedByThisEngine: boolean;
}

export const TELEGRAM_OWNER: TelegramPositionOwner = {
  magicNumber: TELEGRAM_MAGIC,
  engineVersion: TELEGRAM_ENGINE_VERSION,
  label: 'Telegram copy engine — @SFxauusd1',
  managedByThisEngine: true,
};

/** True only for positions Engine B opened itself. */
export function isOwnedByTelegramEngine(magic: number | null | undefined): boolean {
  return magic === TELEGRAM_MAGIC;
}

export type TelegramForeignKind = 'ENGINE_A' | 'OTHER_BOT' | 'MANUAL_OR_UNKNOWN';

export interface TelegramForeignPosition {
  readonly kind: TelegramForeignKind;
  readonly detail: string;
}

/**
 * Classifies a position Engine B does not own, so an operator reading the
 * dashboard sees WHY something is untouchable rather than an undifferentiated
 * "not ours".
 */
export function classifyForeignToTelegram(magic: number | null | undefined): TelegramForeignPosition | null {
  if (isOwnedByTelegramEngine(magic)) return null;
  if (magic === V2_MAGIC_M1 || magic === V2_MAGIC_M5) {
    return {
      kind: 'ENGINE_A',
      detail:
        `Position belongs to the RSI M1/M5 engine (magic ${magic}), which manages its own entries, protection ` +
        'and Friday liquidation. The Telegram engine never closes, modifies or adopts it.',
    };
  }
  if (magic !== null && magic !== undefined && TELEGRAM_FOREIGN_MAGIC_NUMBERS.includes(magic)) {
    return {
      kind: 'OTHER_BOT',
      detail: `Position belongs to another trading application (magic ${magic}). The Telegram engine never acts on it.`,
    };
  }
  return {
    kind: 'MANUAL_OR_UNKNOWN',
    detail:
      magic === null || magic === undefined
        ? 'Manual or unattributable position (no magic number reported) — never acted on by the Telegram engine.'
        : `Unregistered position (magic ${magic}) — never acted on by the Telegram engine.`,
  };
}

export function describeTelegramOwnership(magic: number | null | undefined): string {
  if (isOwnedByTelegramEngine(magic)) return `${TELEGRAM_OWNER.label} (magic ${TELEGRAM_OWNER.magicNumber})`;
  return classifyForeignToTelegram(magic)!.detail;
}

/**
 * Startup assertion: the two engines' magic registries are disjoint.
 *
 * Called during module initialization so a mistaken constant cannot reach the
 * broker. A shared magic would make Engine A's liquidation select Telegram
 * positions, which is the exact outcome the separation requirement forbids.
 */
export function assertEngineSeparation(): void {
  if (TELEGRAM_FOREIGN_MAGIC_NUMBERS.includes(TELEGRAM_MAGIC)) {
    throw new Error(
      `Telegram engine magic ${TELEGRAM_MAGIC} is also listed as belonging to another system. Refusing to ` +
        'start: a shared magic number makes position ownership unattributable.',
    );
  }
  for (const engineA of [V2_MAGIC_M1, V2_MAGIC_M5]) {
    if (engineA === TELEGRAM_MAGIC) {
      throw new Error(
        `Telegram engine magic ${TELEGRAM_MAGIC} collides with the RSI M1/M5 engine. Refusing to start: the ` +
          'RSI engine liquidates by magic number and would close Telegram positions.',
      );
    }
  }
}
