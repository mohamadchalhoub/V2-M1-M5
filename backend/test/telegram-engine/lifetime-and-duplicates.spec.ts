/**
 * The 60-second lifetime and the five ways a signal can arrive twice.
 *
 * These are Engine B's two strategy rules with teeth, and both are about
 * refusing to act rather than about acting, so the interesting assertions are
 * all negative.
 */
import { describe, expect, it } from 'vitest';
import { evaluateFreshness, legMayBeSubmitted } from '../../src/telegram-engine/freshness';
import { evaluateDuplicate, semanticKey, sourceKey } from '../../src/telegram-engine/duplicate';
import { parseTelegramSignal, type ParsedSignal } from '../../src/telegram-engine/parser';
import { TELEGRAM_SPEC } from '../../src/telegram-engine/spec';
import { priorSignalIsLive } from '../../src/telegram-engine/execution.service';

const PUBLISHED = Date.UTC(2026, 8, 23, 16, 0, 0);

function parse(text: string): ParsedSignal {
  const { signal } = parseTelegramSignal(text);
  if (!signal) throw new Error(`fixture failed to parse: ${text}`);
  return signal;
}

const SELL_TWO_TP = parse('Gold sell now 4338\nSL 4348\nTP 4329\nTP 4300');

describe('the hard 60-second lifetime', () => {
  it('is exactly 60 seconds', () => {
    expect(TELEGRAM_SPEC.maxSignalAgeMs).toBe(60_000);
  });

  it('accepts at 59.999s and 60.000s, refuses at 60.001s', () => {
    expect(evaluateFreshness(PUBLISHED, PUBLISHED + 59_999).fresh).toBe(true);
    expect(evaluateFreshness(PUBLISHED, PUBLISHED + 60_000).fresh).toBe(true);
    expect(evaluateFreshness(PUBLISHED, PUBLISHED + 60_001).verdict).toBe('EXPIRED');
  });

  it('accepts a signal submitted immediately', () => {
    expect(evaluateFreshness(PUBLISHED, PUBLISHED).verdict).toBe('FRESH');
  });

  it('accepts at exactly the lifetime — the bound is inclusive', () => {
    expect(evaluateFreshness(PUBLISHED, PUBLISHED + TELEGRAM_SPEC.maxSignalAgeMs).fresh).toBe(true);
  });

  it('refuses one millisecond past the lifetime', () => {
    const r = evaluateFreshness(PUBLISHED, PUBLISHED + TELEGRAM_SPEC.maxSignalAgeMs + 1);
    expect(r.verdict).toBe('EXPIRED');
    expect(r.fresh).toBe(false);
  });

  it('measures from publication, not from receipt — a replayed message past its lifetime is old', () => {
    // Received now, published two hours ago: far past the 60-second lifetime.
    const receivedNow = PUBLISHED + 2 * 60 * 60_000;
    expect(evaluateFreshness(PUBLISHED, receivedNow).verdict).toBe('EXPIRED');
    // Had receipt time been used, the same message would look 0s old.
    expect(evaluateFreshness(receivedNow, receivedNow).verdict).toBe('FRESH');
  });

  it('refuses a message dated in the future beyond the skew tolerance', () => {
    const r = evaluateFreshness(PUBLISHED, PUBLISHED - 10_000);
    expect(r.verdict).toBe('PUBLICATION_IN_FUTURE');
    expect(r.fresh).toBe(false);
  });

  it('tolerates small negative ages, which are ordinary clock skew', () => {
    expect(evaluateFreshness(PUBLISHED, PUBLISHED - 1_000).fresh).toBe(true);
  });
});

describe('the lifetime is re-checked per leg, immediately before each submission', () => {
  it('submits a leg just inside the lifetime and refuses the next one just past it', () => {
    expect(legMayBeSubmitted(PUBLISHED, PUBLISHED + TELEGRAM_SPEC.maxSignalAgeMs - 2_000).fresh).toBe(true);
    expect(legMayBeSubmitted(PUBLISHED, PUBLISHED + TELEGRAM_SPEC.maxSignalAgeMs + 2_000).fresh).toBe(false);
  });

  it('is the same rule as the signal-level check, applied at a later instant', () => {
    const at = PUBLISHED + 30_000;
    expect(legMayBeSubmitted(PUBLISHED, at)).toEqual(evaluateFreshness(PUBLISHED, at));
  });
});

describe('exact message identity', () => {
  const key = { sourceKey: sourceKey('-100123', '77'), semanticKey: semanticKey(SELL_TWO_TP), publishedAtMs: PUBLISHED };
  const prior = [{ ...key }];

  it.each([
    ['Telegram redelivering the same update'],
    ['a replay after a reconnect'],
    ['a replay after an application restart'],
  ])('%s produces no second order', () => {
    const v = evaluateDuplicate(key, prior);
    expect(v.duplicate).toBe(true);
    expect(v.kind).toBe('EXACT_MESSAGE');
  });

  it('is independent of content: an edited repost of the same message id is still that message', () => {
    const edited = { ...key, semanticKey: semanticKey(parse('Gold sell now 4339\nSL 4349\nTP 4330')) };
    expect(evaluateDuplicate(edited, prior).kind).toBe('EXACT_MESSAGE');
  });
});

describe('a repost is only a duplicate while the earlier order is still alive', () => {
  const first = {
    sourceKey: sourceKey('-100123', '77'),
    semanticKey: semanticKey(SELL_TWO_TP),
    publishedAtMs: PUBLISHED,
  };
  const repost = {
    sourceKey: sourceKey('-100123', '78'),
    semanticKey: semanticKey(SELL_TWO_TP),
    publishedAtMs: PUBLISHED + 90_000,
  };

  it('is a duplicate while the earlier order is still live', () => {
    expect(evaluateDuplicate(repost, [{ ...first, live: true }]).duplicate).toBe(true);
  });

  it('is a NEW signal once the earlier order has finished (cancelled, expired, or closed at TP/SL)', () => {
    expect(evaluateDuplicate(repost, [{ ...first, live: false }]).duplicate).toBe(false);
  });

  it('never relaxes the exact-message check: the same message id is a replay, not a new sending', () => {
    const replay = { ...first };
    const v = evaluateDuplicate(replay, [{ ...first, live: false }]);
    expect(v.duplicate).toBe(true);
    expect(v.kind).toBe('EXACT_MESSAGE');
  });
});

describe('priorSignalIsLive', () => {
  // Duplicate only while the order has been TAKEN and is still held.
  it.each([
    ['sent, not yet confirmed (may be live)', [{ orderStatus: 'PENDING', closureComplete: false }], true],
    ['position open', [{ orderStatus: 'FILLED', closureComplete: false }], true],
    ['broker answer lost (may be live)', [{ orderStatus: 'UNKNOWN', closureComplete: false }], true],
    ['position closed (TP or SL)', [{ orderStatus: 'FILLED', closureComplete: true }], false],
    ['broker refused', [{ orderStatus: 'FAILED', closureComplete: false }], false],
    ['skipped, never sent', [{ orderStatus: 'SKIPPED', closureComplete: false }], false],
    ['no order at all (waiting for entry, cancelled, expired, refused)', [], false],
  ])('%s -> live=%s', (_label, legs, expected) => {
    expect(priorSignalIsLive(legs as never)).toBe(expected);
  });
});

describe('semantic reposts under a different message id', () => {
  const first = {
    sourceKey: sourceKey('-100123', '77'),
    semanticKey: semanticKey(SELL_TWO_TP),
    publishedAtMs: PUBLISHED,
  };

  it('treats the same trade republished 90 seconds later as a duplicate', () => {
    const repost = {
      sourceKey: sourceKey('-100123', '78'),
      semanticKey: semanticKey(SELL_TWO_TP),
      publishedAtMs: PUBLISHED + 90_000,
    };
    const v = evaluateDuplicate(repost, [first]);
    expect(v.duplicate).toBe(true);
    expect(v.kind).toBe('SEMANTIC_REPOST');
  });

  it('ignores formatting: "4338" and "4338.0" are the same trade', () => {
    const reformatted = parse('Gold sell now 4338.0\nSL 4348.00\nTP 4329.0\nTP 4300');
    expect(semanticKey(reformatted)).toBe(semanticKey(SELL_TWO_TP));
  });

  it('lets a genuine re-entry at the same level through once the window has passed', () => {
    const later = {
      sourceKey: sourceKey('-100123', '120'),
      semanticKey: semanticKey(SELL_TWO_TP),
      publishedAtMs: PUBLISHED + TELEGRAM_SPEC.semanticDuplicateWindowMs + 1,
    };
    expect(evaluateDuplicate(later, [first]).duplicate).toBe(false);
  });

  it('does not collide a two-target signal with a three-target repost of it', () => {
    // A third target asks for a third position. That is a different
    // instruction, and must not be silently swallowed as a duplicate.
    const threeTargets = parse('Gold sell now 4338\nSL 4348\nTP 4329\nTP 4300\nTP 4280');
    expect(semanticKey(threeTargets)).not.toBe(semanticKey(SELL_TWO_TP));
  });

  it('does not collide a BUY with a SELL at the same levels', () => {
    const buy = parse('Gold buy now 4300\nSL 4290\nTP 4310');
    const sell = parse('Gold sell now 4300\nSL 4310\nTP 4290');
    expect(semanticKey(buy)).not.toBe(semanticKey(sell));
  });

  it('records a duplicate as consumed rather than as something to retry', () => {
    const v = evaluateDuplicate({ ...first, sourceKey: sourceKey('-100123', '78') }, [first]);
    expect(v.detail).toMatch(/no additional positions/i);
  });
});
