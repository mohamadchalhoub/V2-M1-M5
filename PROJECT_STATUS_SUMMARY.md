# Project Status — Plain-Language Summary

**Date:** 2026-09-12 · **Branch:** `audit/strategy-and-data-integrity` (129 files ahead of `master`, unmerged) · Full detail in `PROJECT_STATUS_REPORT.md`

## What this is

A personal MT5 trading system with two strategy engines built at different times:
- **Legacy strategy** (`weekly-h4-sr-v1`) — an AI-assisted rule engine. Archived; no longer being developed further, but it's the more "finished" one in terms of plumbing.
- **New strategy** (`h4-trend-h1-breakout-v1`) — a fully deterministic (no AI) EURUSD/gold breakout strategy, built and extensively tested on this branch. This is the one under active development.

## What works right now

- The new strategy's **signal logic is correct and well-tested**: 93/93 dedicated tests pass, and a detailed line-by-line code audit this session found the tricky parts (the ATR Wilder-smoothing formula, the "fresh breakout" off-by-one that's easy to get wrong, the SL/TP rounding-collapse rejection) are all implemented correctly.
- The **legacy strategy's order-placement code is real and reasonably careful**: it double-checks it's talking to a demo account before every order, uses a real database-level lock to prevent the same decision being executed twice, and never silently treats a failed or ambiguous broker response as a success.
- **Historical trade data checks out**: 865 previously-reported closed positions (648 of them EURUSD) are exactly reproducible from the live database.
- **121 collector tests and 744 backend tests pass** with zero genuine failures found this session (a further 209 tests were skipped because of one missing local test dependency, not a bug).

## What's incomplete or not connected

- **The new strategy has never actually run.** Nothing schedules it — not once, automatically, ever. It only runs when a test calls it directly. Zero decisions have ever been logged for it in the database.
- **Nothing currently knows the account's balance or the broker's actual trading rules for these instruments** — that data has simply never been collected for the account currently configured, because no live collector session has been run against it yet.
- **Gold has no historical price data at all** — it was never turned on for data collection, so it can't be backtested or eventually traded yet.
- A handful of real safety pieces exist as tested code but are **not wired to anything that runs** — most notably, the "if a position loses its stop-loss, fix it or close the position" logic is fully built and tested but has zero real callers, and the "don't open a second position if one is already open manually" check doesn't look at manual trades at all today.
- The kill switch (an emergency stop) only prevents a *new* decision from being created — it can't close a position that's already open, and it isn't re-checked once a trade is already queued for execution.
- **Two of the previously reported figures could not be independently re-confirmed this session**: the exact EURUSD backtest numbers (76 trades, 38.16% win rate, +$316.32) rest on an earlier, unreproduced run — an attempt to rerun the same script this session was blocked by a safety control, not by any problem with the script itself. And a data-provenance question was found: documentation says the historical trade import went through a tracked process that should have left an audit record, but that audit record is currently missing from the database (the trade data itself is fine and matches what was reported).
- Several of the project's own root-level documents (`PROJECT_STATUS.md` and others) turned out to describe a **different, earlier project** this one was forked from — they still reference a different account and a different deployment, and should not be read as describing this codebase's current state.

## Can this system place a real trade right now?

**No.** Two independent switches both have to be flipped, and neither is: a config flag (`AUTONOMOUS_EXECUTION_ENABLED`) is off, and even if it were turned on, nothing currently produces an order for it to act on — that requires a person to manually run a specific script. The new strategy has no order-placement code at all yet, by design, per its own spec.

## Is the account confirmed to be a demo account?

The order-placing code independently re-checks this against the live broker connection every time (a real safety property, not just a config setting) — but the specific account now configured in this environment has never actually had a real connection observed in this session's evidence. An earlier, different account did connect successfully and was confirmed demo.

## Has profitability been demonstrated?

**No, not yet, in any rigorous sense.** The one available backtest result (not independently re-confirmed this session) did not model starting account equity, commissions, swap, or realistic slippage, and covers EURUSD only — gold has no historical data to test against at all. It should be read as "the rule, as written, would have made a small number of trades with mixed results over one historical sample," not as evidence of a working trading edge.

## Recommended next step

Run one supervised, execution-disabled collector session against the currently-configured demo account long enough to record its balance and the broker's actual trading rules for EURUSD and gold, and to start collecting gold price history. That single step unblocks almost everything else in the plan — a trustworthy backtest, and eventually turning on the new strategy in "watch only, log what it would have done" mode with still zero risk of a real trade.

Full findings, file-by-file evidence, and a prioritized task list are in `PROJECT_STATUS_REPORT.md`.
