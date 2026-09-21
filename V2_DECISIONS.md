# xauusd-m1-m5-rsi-threshold-v2 — confirmed decisions and open items

This file records decisions that are settled, so they are not re-litigated,
and the items still blocking implementation. It is not the strategy
specification; the frozen specification will be a separate file.

## Source and identity

| | |
|---|---|
| Source commit | `bf083c8` (via `trading-monitor-autonomous`, see PROVENANCE.md) |
| This project's initial commit | `4103332` — *Start from trading-monitor-autonomous at bf083c8* |
| New bot id | `xauusd-m1-m5-rsi-threshold-v2` |
| Project location | `C:\Users\user\Desktop\trading-monitor-m1-m5-v2` (own Git repo, no remote) |

The existing M1-only revision-5 bot (`xauusd-m1-rsi-retest-extremes-v1`) and
the separate version 1 deployment continue running unchanged. Nothing in this
project may act on their databases, terminals, accounts or positions.

## Confirmed by the user (2026-09-21)

1. **Additional daily entry pause — 14:00 to 19:00 on the SAME day**,
   Asia/Beirut, 14:00 inclusive and 19:00 exclusive. The specification's
   "the following day" wording is not the intended reading. This resolves the
   section 6 question; execution remains OFF until the full schedule is
   verified end to end.
2. **Historical-data scope — live path only.** Build indicator initialization
   (the candle history needed to seed RSI) and broker-record retrieval (for
   reconciliation, realized results and lock persistence). Do **not** build
   backtesting or historical performance evaluation for this bot.
3. **Strategy code waits for the detailed specification.** Infrastructure,
   isolation and identity work proceeds; the RSI/crossing engine, the lock
   state machine and the schedule gates are not written until the detailed
   specification is supplied, to avoid implementing an inferred rule set.

## Schedule, as it stands

All times Asia/Beirut, with DST handling; entry pauses never close existing
positions.

- Overnight entry pause 23:30 to 01:00.
- Additional daily entry pause 14:00 (inclusive) to 19:00 (exclusive), same day.
- Friday entry cutoff 23:00; liquidation begins 23:00; broker-confirmed
  closure targeted before 23:30.

## Reserved identifiers (not yet wired in)

Existing magic numbers, which must not be reused: 262610180 (legacy weekly
H4 S/R), 262610181 (gold execution / archived H4 confirmed retest),
262610190 and 262610191 (the running M1 revision-5 bot).

Proposed for this bot, pending the specification: 262610200 for the M1 path
and 262610201 for the M5 path — one per timeframe, so the two positions the
bot may hold simultaneously are independently attributable at the broker.

## Open items blocking activation

- The detailed strategy specification has not been supplied.
- A dedicated MT5 DEMO account, its own terminal/Wine prefix and its own
  collector credentials.
- Its own Telegram bot token and chat ids.
- A dashboard hostname for this bot.
- Confirmation that the broker account supports hedging, required for
  simultaneous independent M1 and M5 positions.

Execution stays OFF until every item above is resolved and verified.
