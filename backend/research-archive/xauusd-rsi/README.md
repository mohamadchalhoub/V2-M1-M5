# Archived research — XAUUSD M1 RSI retest/extremes

**Nothing in this directory describes the live DEMO account.**

Everything here is *simulation* output produced before the scope of the work
was narrowed to live DEMO operation. It is retained as a record of what was
run, not as evidence about the strategy.

## What these numbers are not

The figures previously reported from this material — a **+$513.50** result
and a **$4,500** maximum drawdown over 882,817 M1 bars — are the output of a
closed-bar approximation replayed over stored candles. They are:

- not a realised profit or loss,
- not a DEMO account balance or equity change,
- not a broker statement,
- not a prediction.

The approximation is measurably a different strategy from the one that
trades: over the *same* 1.54 days of tick coverage the approximation produced
1 signal while the faithful tick replay produced 39.

Real DEMO performance is whatever the live account and the recorded decision,
fill and closure rows say it is. Read that from the dashboard and the
database, never from this directory.

## Status

Not part of live operation. Not an activation criterion. The strategy's rules
are fixed by its specification and are **not** changed on the basis of
anything here. The evaluation script is kept in this directory rather than in
`backend/scripts/`, and is deliberately no longer exposed as an npm script,
so it cannot be run as part of routine operation.

## Contents

| File | What it is |
|---|---|
| `xauusd-rsi-evaluate.ts` | The simulation script, as it stood when it was retired |
| `xauusd-rsi-evaluation-revision-2.json` | Its raw output for spec revision 2 |

Revision 1 output remains in git history at commit `56ee479`.
