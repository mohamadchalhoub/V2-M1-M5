/**
 * The ingestion edge: which messages are allowed to reach the parser at all.
 *
 * This is the boundary where a stranger's text either does or does not become
 * an order, so the tests are about refusal far more than acceptance. The
 * authenticated account is a normal Telegram user that anybody can message;
 * the only thing standing between a direct message and the trading pipeline
 * is the channel guard.
 */
import { describe, expect, it } from 'vitest';
import {
  checkSourceChannel,
  displayChannelId,
  normaliseChannelId,
  type IncomingPeer,
} from '../../src/telegram-engine/ingestion/channel-guard';
import { maskIfPhoneLike } from '../../src/telegram-engine/ingestion/session-store';

const SOURCE = '1234567890';

function peer(over: Partial<IncomingPeer> = {}): IncomingPeer {
  return { channelId: SOURCE, username: 'SFxauusd1', isChannel: true, ...over };
}

describe('only the configured source channel is accepted', () => {
  it('accepts the configured channel', () => {
    expect(checkSourceChannel(peer(), SOURCE).accepted).toBe(true);
  });

  it('refuses another channel even when its username matches the source', () => {
    // The username is attacker-controllable: a channel can be renamed, and a
    // freed username can be claimed by anyone. The id is what is trusted.
    const impostor = peer({ channelId: '9999999999', username: 'SFxauusd1' });
    const check = checkSourceChannel(impostor, SOURCE);
    expect(check.accepted).toBe(false);
    expect(check.verdict).toBe('WRONG_CHANNEL');
  });

  it.each([
    ['a private chat', { isChannel: false, channelId: null }],
    ['a group', { isChannel: false }],
    ['Saved Messages', { isChannel: false, username: null, channelId: null }],
  ])('refuses %s', (_label, over) => {
    const check = checkSourceChannel(peer(over as Partial<IncomingPeer>), SOURCE);
    expect(check.accepted).toBe(false);
    expect(check.verdict).toBe('NOT_A_CHANNEL');
  });

  it('refuses an update whose channel id could not be resolved', () => {
    expect(checkSourceChannel(peer({ channelId: null }), SOURCE).verdict).toBe('WRONG_CHANNEL');
  });

  it('accepts NOTHING when no source channel has been resolved', () => {
    // The dangerous default would be to fall back to the username. It does
    // not: an unconfigured source accepts nothing at all.
    const check = checkSourceChannel(peer(), null);
    expect(check.accepted).toBe(false);
    expect(check.verdict).toBe('SOURCE_NOT_CONFIGURED');
  });
});

describe('channel id normalisation', () => {
  it('treats the MTProto and Bot API forms as the same channel', () => {
    // An operator copying the id from a bot tool gets -100123...; MTProto
    // reports 123.... Both must match, or the guard would silently never
    // match and the channel would look permanently quiet.
    expect(checkSourceChannel(peer({ channelId: '1234567890' }), '-1001234567890').accepted).toBe(true);
    expect(checkSourceChannel(peer({ channelId: '-1001234567890' }), '1234567890').accepted).toBe(true);
  });

  it('normalises consistently', () => {
    expect(normaliseChannelId('-1001234567890')).toBe('1234567890');
    expect(normaliseChannelId('1234567890')).toBe('1234567890');
    expect(normaliseChannelId(' -1001234567890 ')).toBe('1234567890');
  });

  it('displays the -100 form operators recognise', () => {
    expect(displayChannelId('1234567890')).toBe('-1001234567890');
  });

  it('does not collide two different channels through normalisation', () => {
    expect(normaliseChannelId('1234567890')).not.toBe(normaliseChannelId('1234567891'));
  });
});

describe('what may be said about the session', () => {
  it('masks a phone number down to its last two digits', () => {
    expect(maskIfPhoneLike('+96170123456')).toBe('*********56');
  });

  it('leaves a username alone', () => {
    expect(maskIfPhoneLike('@someuser')).toBe('@someuser');
  });

  it('handles an absent label', () => {
    expect(maskIfPhoneLike(null)).toBeNull();
  });
});
