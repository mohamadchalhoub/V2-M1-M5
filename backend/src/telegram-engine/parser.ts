/**
 * Turning a Telegram post into a trade, or refusing to.
 *
 * The channel is written for humans. Most of what it publishes is commentary,
 * results, screenshots and chat, and only some of it is a trade instruction.
 * The parser's job is therefore not "extract the numbers" but **decide
 * whether this message is a trade instruction at all**, and the bias is
 * heavily towards saying no: a false negative costs one missed copy, while a
 * false positive opens real positions from a sentence that was never an
 * order.
 *
 * So a message becomes a signal only when ALL of the following are present
 * and unambiguous:
 *
 *   - the symbol, as "gold" or "xauusd" (the engine trades nothing else);
 *   - exactly one direction word, buy or sell;
 *   - an explicit entry price;
 *   - an explicit stop loss;
 *   - at least one take profit.
 *
 * Anything missing is a refusal with a reason, never a guess. In particular
 * there is no "assume market entry" and no "derive SL from the TP distance" —
 * a copy engine that invents a stop is not copying.
 *
 * ## Why the numbers are range-checked
 *
 * `TP 1` and `TP 2` are ordinal labels in some channels' formatting, not
 * prices. A gold price is a four-figure number; accepting `1` as a
 * take-profit would place a protective level at one dollar and turn a copy
 * into an unbounded trade. Every extracted price must look like a gold price,
 * and a message that mixes plausible and implausible prices is refused rather
 * than partially read.
 */
import { TELEGRAM_SPEC, type Direction } from './spec';

export type ParseRefusal =
  | 'NOT_A_TRADE_MESSAGE'
  | 'SYMBOL_NOT_GOLD'
  | 'DIRECTION_MISSING'
  | 'DIRECTION_AMBIGUOUS'
  | 'ENTRY_MISSING'
  | 'STOP_LOSS_MISSING'
  | 'TAKE_PROFIT_MISSING'
  | 'TOO_MANY_TAKE_PROFITS'
  | 'IMPLAUSIBLE_PRICE'
  | 'STOP_LOSS_ON_WRONG_SIDE'
  | 'TAKE_PROFIT_ON_WRONG_SIDE'
  | 'DUPLICATE_TAKE_PROFIT';

export interface ParsedSignal {
  readonly direction: Direction;
  /** The entry price the channel published. Never invented, never a quote. */
  readonly entry: number;
  readonly stopLoss: number;
  /** In published order; each becomes one independent 0.01-lot leg. */
  readonly takeProfits: readonly number[];
}

export interface ParseResult {
  readonly signal: ParsedSignal | null;
  readonly refusal: ParseRefusal | null;
  readonly detail: string | null;
}

/**
 * The band a number must fall in to be accepted as a gold price.
 *
 * Wide enough to survive years of price history, narrow enough to reject
 * ordinal labels, lot sizes, pip counts and percentages — which is the entire
 * class of number that shows up in these messages alongside genuine prices.
 */
const GOLD_PRICE_MIN = 500;
const GOLD_PRICE_MAX = 20_000;

const SYMBOL_RE = /\b(gold|xau\s*\/?\s*usd|xauusd)\b/i;
const BUY_RE = /\b(buy|long)\b/i;
const SELL_RE = /\b(sell|short)\b/i;

/**
 * A price token. Thousands separators are tolerated because these posts use
 * them inconsistently ("4,338" and "4338" in the same message); a fractional
 * part is optional.
 */
const PRICE = String.raw`(\d{1,2},?\d{3}(?:\.\d{1,3})?|\d{3,5}(?:\.\d{1,3})?)`;

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

function plausible(price: number): boolean {
  return Number.isFinite(price) && price >= GOLD_PRICE_MIN && price <= GOLD_PRICE_MAX;
}

export function parseTelegramSignal(text: string | null | undefined): ParseResult {
  const refuse = (refusal: ParseRefusal, detail: string): ParseResult => ({ signal: null, refusal, detail });

  if (typeof text !== 'string' || text.trim() === '') {
    return refuse('NOT_A_TRADE_MESSAGE', 'Message has no text.');
  }
  // Normalize the decorations these posts carry — emoji, bullets, arrows and
  // bold markers — to whitespace, so a label glued to its value ("TP:4329"
  // preceded by an emoji) still reads as a labelled price. Digits, letters,
  // separators and the characters that matter to a price survive.
  const normalized = text.replace(/[^\p{L}\p{N}.,:@\-\/\s]/gu, ' ');

  if (!SYMBOL_RE.test(normalized)) {
    return refuse(
      'SYMBOL_NOT_GOLD',
      'Message does not name gold or XAUUSD. This engine trades one symbol and never infers it.',
    );
  }

  const isBuy = BUY_RE.test(normalized);
  const isSell = SELL_RE.test(normalized);
  if (isBuy && isSell) {
    return refuse(
      'DIRECTION_AMBIGUOUS',
      'Message contains both a buy and a sell word. Refusing rather than choosing one.',
    );
  }
  if (!isBuy && !isSell) return refuse('DIRECTION_MISSING', 'Message contains no buy or sell instruction.');
  const direction: Direction = isBuy ? 'BUY' : 'SELL';

  // --- Stop loss. Labelled, always: an unlabelled number is never read as a
  // stop, because being wrong about which number is the stop is worse than
  // not trading at all.
  const slMatch = normalized.match(new RegExp(String.raw`\b(?:sl|stop\s*loss|stop)\b\s*[:@=\-]?\s*` + PRICE, 'i'));
  if (!slMatch) {
    return refuse('STOP_LOSS_MISSING', 'No explicit stop loss. This engine never derives or invents one.');
  }
  const stopLoss = toNumber(slMatch[1]);

  // --- Take profits, in published order, labelled the same way. `TP1`/`TP 2`
  // ordinals are absorbed by an optional single digit after the label.
  const tpRe = new RegExp(String.raw`\b(?:tp|take\s*profit|target)\s*\d?\b\s*[:@=\-]?\s*` + PRICE, 'gi');
  const takeProfits: number[] = [];
  for (const m of normalized.matchAll(tpRe)) takeProfits.push(toNumber(m[1]));
  if (takeProfits.length === 0) {
    return refuse('TAKE_PROFIT_MISSING', 'No explicit take profit. A signal without a target is not copied.');
  }
  if (takeProfits.length > TELEGRAM_SPEC.maxTakeProfits) {
    return refuse(
      'TOO_MANY_TAKE_PROFITS',
      `Parsed ${takeProfits.length} take profits, beyond the ${TELEGRAM_SPEC.maxTakeProfits} this engine will ` +
        'open at once. That is far more likely a misparse than a genuine signal, so nothing is opened.',
    );
  }
  if (new Set(takeProfits).size !== takeProfits.length) {
    return refuse(
      'DUPLICATE_TAKE_PROFIT',
      'The same take profit appears twice. Refusing rather than opening two identical legs.',
    );
  }

  // --- Entry. Whatever price sits with the direction word, or the first
  // plausible price not already spoken for as the stop or a target — so
  // "sell now 4338" can never accidentally resolve to the stop.
  const entry = findEntry(normalized, direction, stopLoss, takeProfits);
  if (entry === null) {
    return refuse('ENTRY_MISSING', 'No explicit entry price. Market entry is never assumed.');
  }

  const labelled: Array<[string, number]> = [
    ['entry', entry],
    ['stop loss', stopLoss],
    ...takeProfits.map((tp, i): [string, number] => [`take profit ${i + 1}`, tp]),
  ];
  for (const [label, price] of labelled) {
    if (!plausible(price)) {
      return refuse(
        'IMPLAUSIBLE_PRICE',
        `Parsed ${label} ${price} is not a plausible gold price (${GOLD_PRICE_MIN}-${GOLD_PRICE_MAX}). The ` +
          'message is refused whole rather than partially read.',
      );
    }
  }

  // --- Geometry. A SELL whose stop is below entry is a take profit, and a
  // BUY whose target is below entry is a stop. Either means the message was
  // read wrongly, whatever the numbers look like individually.
  const slOnRightSide = direction === 'BUY' ? stopLoss < entry : stopLoss > entry;
  if (!slOnRightSide) {
    return refuse(
      'STOP_LOSS_ON_WRONG_SIDE',
      `${direction} entry ${entry} with stop ${stopLoss} is inverted. Refusing rather than submitting brackets ` +
        'that mean the opposite of what was published.',
    );
  }
  const badTp = takeProfits.find((tp) => (direction === 'BUY' ? tp <= entry : tp >= entry));
  if (badTp !== undefined) {
    return refuse('TAKE_PROFIT_ON_WRONG_SIDE', `${direction} entry ${entry} with take profit ${badTp} is inverted.`);
  }

  return { signal: { direction, entry, stopLoss, takeProfits }, refusal: null, detail: null };
}

/**
 * Locates the entry price.
 *
 * Preference order matters: a price adjacent to the direction word is what
 * the author meant by "sell now 4338", and only when there is none does the
 * parser fall back to the first unclaimed plausible price. Both paths exclude
 * numbers already read as the stop or a target, so the entry can never be a
 * second reading of a level that already has another job.
 */
function findEntry(
  normalized: string,
  direction: Direction,
  stopLoss: number,
  takeProfits: readonly number[],
): number | null {
  const claimed = new Set<number>([stopLoss, ...takeProfits]);
  const word = direction === 'BUY' ? String.raw`(?:buy|long)` : String.raw`(?:sell|short)`;

  // "sell now 4338", "sell @4338", "sell gold 4338", "sell limit 4338".
  const adjacent = normalized.match(
    new RegExp(
      String.raw`\b` + word + String.raw`\b(?:\s+(?:now|gold|xauusd|at|from|limit|stop|zone|entry|price))*\s*[:@=\-]?\s*` + PRICE,
      'i',
    ),
  );
  if (adjacent) {
    const value = toNumber(adjacent[1]);
    if (!claimed.has(value)) return value;
  }

  const byLabel = normalized.match(new RegExp(String.raw`\b(?:entry|enter|price)\b\s*[:@=\-]?\s*` + PRICE, 'i'));
  if (byLabel) {
    const value = toNumber(byLabel[1]);
    if (!claimed.has(value)) return value;
  }

  for (const m of normalized.matchAll(new RegExp(PRICE, 'g'))) {
    const value = toNumber(m[1]);
    if (!claimed.has(value) && plausible(value)) return value;
  }
  return null;
}

/** Bumped whenever extraction rules change, and stored on every signal. */
export const TELEGRAM_PARSER_VERSION = "2";
