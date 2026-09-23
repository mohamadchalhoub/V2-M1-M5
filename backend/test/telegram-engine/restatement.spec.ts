/**
 * Restatement detection, built from the source channel's REAL behaviour.
 *
 * Every fixture below is a verbatim message observed in a 100-message scan of
 * `@SFxauusd1` on 2026-09-22/23. That matters: the rule exists because of what
 * this channel actually does, and a test written from an imagined format
 * would not have caught it.
 *
 * The observed pattern is that a signal is published and then republished
 * within seconds — sometimes byte-identical, sometimes with the target list
 * changed by a dollar or with an extra target appended. The identical ones
 * were already handled. The varied ones were not: a different target list is
 * a different `semanticKey`, so they read as new trades and only signal-group
 * occupancy stood between a repost and a second position.
 */
import { describe, expect, it } from 'vitest';
import { evaluateDuplicate, restatementKey, semanticKey, sourceKey } from '../../src/telegram-engine/duplicate';
import { parseTelegramSignal, type ParsedSignal } from '../../src/telegram-engine/parser';
import { TELEGRAM_SPEC } from '../../src/telegram-engine/spec';

function parse(text: string): ParsedSignal {
  const { signal } = parseTelegramSignal(text);
  if (!signal) throw new Error(`fixture failed to parse: ${text}`);
  return signal;
}

/** Verbatim from the channel, including the blank lines and the Arabic tail. */
const REAL = {
  // 14:48:48 and 14:48:55 — identical, then 14:49:06 with a target added.
  buy4316_oneTp: parse('Gold buy now 4316\n\nSl 4305\n\nTp 4323\nخمس مرات'),
  buy4316_twoTp: parse('Gold buy now 4316\n\nSl 4305\n\nTp 4323\nTp 4360'),
  // 00:12:24 then 00:12:32 — target moved by one dollar.
  buy4361_tp4367: parse('Gold buy now 4361\n\nSl 4349\n\nTp 4367\nخمس مرات'),
  buy4361_tp4368: parse('Gold buy now 4361\n\nSl 4349\n\nTp 4368\nخمس مرات'),
  // 01:14:23 and 01:14:25 — byte-identical.
  sell4349: parse('Gold sell now 4349\n\nSl 4360\n\nTp 4338\nTp 4300'),
};

const T0 = Date.UTC(2026, 8, 22, 14, 48, 48);

function prior(signal: ParsedSignal, messageId: string, atMs: number) {
  return {
    sourceKey: sourceKey('-1002014074104', messageId),
    semanticKey: semanticKey(signal),
    restatementKey: restatementKey(signal),
    publishedAtMs: atMs,
  };
}

function candidate(signal: ParsedSignal, messageId: string, atMs: number) {
  return prior(signal, messageId, atMs);
}

describe('the channel parses correctly, exactly as observed', () => {
  it('reads the real SELL format', () => {
    expect(REAL.sell4349).toEqual({
      direction: 'SELL',
      entry: 4349,
      stopLoss: 4360,
      takeProfits: [4338, 4300],
    });
  });

  it('reads the real BUY format, ignoring the Arabic tail line', () => {
    expect(REAL.buy4316_oneTp).toEqual({
      direction: 'BUY',
      entry: 4316,
      stopLoss: 4305,
      takeProfits: [4323],
    });
  });

  it.each([
    ['اعتمد وهتدلع 🫡'],
    ['شراء الذهب الان'],
    ['بيع'],
    ['ضربت الهدف 😎'],
    ['الذهب مع السفاح زي الواحدة لما تعوز ترتاح 🚀🚀🚀'],
    ['BOOOOOOOOOOOOOOOOOOOOOOOOOOOO'],
  ])('refuses real channel commentary: %s', (text) => {
    expect(parseTelegramSignal(text).signal).toBeNull();
  });
});

describe('a byte-identical repost', () => {
  it('is caught by the exact content fingerprint, as before', () => {
    const first = prior(REAL.sell4349, '77275', T0);
    const repost = candidate(REAL.sell4349, '77276', T0 + 2_000);
    const verdict = evaluateDuplicate(repost, [first]);
    expect(verdict.duplicate).toBe(true);
    expect(verdict.kind).toBe('SEMANTIC_REPOST');
  });
});

describe('a restatement with the target list VARIED', () => {
  it('catches a target moved by one dollar (message 77263 -> 77267)', () => {
    const first = prior(REAL.buy4361_tp4367, '77263', T0);
    const restated = candidate(REAL.buy4361_tp4368, '77267', T0 + 8_000);

    // The whole point: these are NOT equal by the exact fingerprint.
    expect(semanticKey(REAL.buy4361_tp4367)).not.toBe(semanticKey(REAL.buy4361_tp4368));

    const verdict = evaluateDuplicate(restated, [first]);
    expect(verdict.duplicate).toBe(true);
    expect(verdict.kind).toBe('RESTATEMENT');
  });

  it('catches a target ADDED (message 77242 -> 77250)', () => {
    const first = prior(REAL.buy4316_oneTp, '77242', T0);
    const restated = candidate(REAL.buy4316_twoTp, '77250', T0 + 18_000);

    expect(semanticKey(REAL.buy4316_oneTp)).not.toBe(semanticKey(REAL.buy4316_twoTp));

    const verdict = evaluateDuplicate(restated, [first]);
    expect(verdict.duplicate).toBe(true);
    expect(verdict.kind).toBe('RESTATEMENT');
  });

  it('explains itself in terms an operator can check against the channel', () => {
    const verdict = evaluateDuplicate(candidate(REAL.buy4316_twoTp, '77250', T0 + 18_000), [
      prior(REAL.buy4316_oneTp, '77242', T0),
    ]);
    expect(verdict.detail).toMatch(/same entry, same stop/);
    expect(verdict.detail).toMatch(/77242/);
  });

  it('the FIRST message of a burst is the one that trades', () => {
    // Stated as a test because it is the accepted cost of the rule: where the
    // channel restates with an added target, the narrower earlier version is
    // the one taken.
    const first = prior(REAL.buy4316_oneTp, '77242', T0);
    expect(evaluateDuplicate(candidate(REAL.buy4316_oneTp, '77242', T0), []).duplicate).toBe(false);
    expect(evaluateDuplicate(candidate(REAL.buy4316_twoTp, '77250', T0 + 18_000), [first]).duplicate).toBe(true);
  });
});

describe('what the restatement key deliberately does NOT suppress', () => {
  it('a different entry is a different trade', () => {
    const first = prior(REAL.buy4316_oneTp, '77242', T0);
    const other = candidate(REAL.buy4361_tp4367, '77263', T0 + 60_000);
    expect(evaluateDuplicate(other, [first]).duplicate).toBe(false);
  });

  it('a different stop at the same entry is a different trade', () => {
    const wider = parse('Gold buy now 4316\n\nSl 4290\n\nTp 4323');
    expect(restatementKey(wider)).not.toBe(restatementKey(REAL.buy4316_oneTp));
    expect(evaluateDuplicate(candidate(wider, '9', T0 + 5_000), [prior(REAL.buy4316_oneTp, '77242', T0)]).duplicate).toBe(
      false,
    );
  });

  it('the opposite direction at the same levels is a different trade', () => {
    const sell = parse('Gold sell now 4316\n\nSl 4330\n\nTp 4300');
    expect(restatementKey(sell)).not.toBe(restatementKey(REAL.buy4316_oneTp));
  });

  it('a genuine re-entry after the window is allowed', () => {
    const first = prior(REAL.buy4316_oneTp, '77242', T0);
    const later = candidate(REAL.buy4316_twoTp, '90000', T0 + TELEGRAM_SPEC.semanticDuplicateWindowMs + 1);
    expect(evaluateDuplicate(later, [first]).duplicate).toBe(false);
  });

  it('a prior row without a restatement key cannot match, rather than matching everything', () => {
    // Rows written before this rule existed have a null key. Treating null as
    // a wildcard would suppress every subsequent signal.
    const legacy = { ...prior(REAL.buy4316_oneTp, '77242', T0), restatementKey: null };
    expect(evaluateDuplicate(candidate(REAL.buy4316_twoTp, '77250', T0 + 18_000), [legacy]).duplicate).toBe(false);
  });
});

describe('precedence between the three checks', () => {
  it('an exact message repeat reports as EXACT_MESSAGE, not RESTATEMENT', () => {
    const first = prior(REAL.sell4349, '77275', T0);
    const same = candidate(REAL.sell4349, '77275', T0 + 1_000);
    expect(evaluateDuplicate(same, [first]).kind).toBe('EXACT_MESSAGE');
  });

  it('identical content under a new id reports as SEMANTIC_REPOST, not RESTATEMENT', () => {
    const first = prior(REAL.sell4349, '77275', T0);
    const repost = candidate(REAL.sell4349, '77276', T0 + 2_000);
    expect(evaluateDuplicate(repost, [first]).kind).toBe('SEMANTIC_REPOST');
  });
});

describe('the full observed burst, replayed in order', () => {
  it('trades once and consumes the rest', () => {
    // 14:48:48 -> 14:48:55 -> 14:49:06, exactly as the channel published it.
    const burst = [
      { signal: REAL.buy4316_oneTp, id: '77242', at: T0 },
      { signal: REAL.buy4316_oneTp, id: '77246', at: T0 + 7_000 },
      { signal: REAL.buy4316_twoTp, id: '77250', at: T0 + 18_000 },
    ];

    const recorded: ReturnType<typeof prior>[] = [];
    const outcomes: (string | null)[] = [];
    for (const item of burst) {
      const c = candidate(item.signal, item.id, item.at);
      const verdict = evaluateDuplicate(c, recorded);
      outcomes.push(verdict.kind);
      // Every message is recorded whether or not it traded, which is what
      // makes the next one recognisable as a repeat.
      recorded.push(c);
    }

    expect(outcomes).toEqual([null, 'SEMANTIC_REPOST', 'RESTATEMENT']);
    expect(outcomes.filter((o) => o === null)).toHaveLength(1);
  });
});
