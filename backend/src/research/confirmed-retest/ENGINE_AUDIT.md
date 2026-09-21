# Audit of the earlier `research/first-touch` engine (2026-09-14)

Scope: `src/research/first-touch/engine.ts` as of commit `f459067`. The earlier commits claimed fixes
(gap races, entry candle, reachability proof, wick touches); this audit re-checked the code rather than
relying on those claims. The earlier module is left in place (it has its own tests) but is
**superseded** for gold research by `research/confirmed-retest` and must not be used for new results.

| # | Finding | Effect | v1 treatment |
|---|---|---|---|
| A1 | **Time basis.** Stored MT5 candle times are broker-server wall clock (EET/EEST), but the engine's Beirut window and all "UTC" labels treated them as true UTC. | Server clock ≈ Beirut clock already; converting it to Beirut again adds another 2–3 h, so a "04:00–12:00 Beirut" window applied to stored bars would really select ~01:00–09:00 Beirut. Every "UTC" timestamp in earlier case studies was server time (2–3 h ahead of true UTC). | `data-source.ts` converts server clock → UTC with IANA `EET`; evidence in spec §3.2. |
| A2 | `findOverlappingGap` returns the **first** overlapping gap (`Array.find`). In `findFirstTouch`, if a CONFIRMED_CLOSURE precedes an UNCONFIRMED gap in the scanned range, the unconfirmed one is never seen. | A touch or TP/SL hidden in an unconfirmed gap could be reported as TOUCHED / NOT_TOUCHED / WIN / LOSS with false certainty. Levels span many weekends, so this is the common case, not an edge case. | Gaps are attached to the specific evaluation bar they precede and handled one by one. |
| A3 | `tryGap` treats **any** tick inside an unconfirmed gap with no crossing as proof the gap was clean. | The sparse-tick fallacy fixed elsewhere survives here. | Ticks only with source-attested completeness **and** exact OHLC reconciliation; otherwise INDETERMINATE (or M5-bridged). |
| A4 | Same-bar TP/SL race on later candles uses ticks without any coverage check (`scanTicksForCrossing`). | Partial ticks can pick a winner. | Same rule as A3. |
| A5 | `MAX_TICK_GAP_MS = 5s` is used as verification of tick completeness. | Not proof; a missing tick can reverse the order. | Not used as evidence. |
| A6 | Float arithmetic: `entryPrice + 10`, `high >= tp` on JS doubles. | Exact-boundary touches (price exactly at TP/SL/level) can be misclassified by representation error. | Integer broker units throughout. |
| A7 | Entry-candle `resolveOhlcCandle`: the reachability argument itself was re-derived and is **correct**, and v1 reuses it (now verified against a brute-force path oracle). But any `>1` reachable result is AMBIGUOUS even when WIN-now and NONE-then-WIN both end as WIN. | Over-conservative (never favourable), slightly understates determinate events. | Final results are combined across branches (§7); release-time differences are handled by paper-sim forks. |
| A8 | A gap straight through the level still produced an ordinary trade at the gapped open (`executableEntryPrice = open`). | Counts a non-exact-price fill as an entry. | GAP_CROSS consumes the level, no entry, reported separately. |
| A9 | Approach direction inferred from the last close outside the zone; entry direction therefore depends on history rather than the level's formation side. | Could create BUY at resistance / SELL at support geometries. | Direction fixed by role; the opposite-side open is GAP_CROSS. |
| A10 | `findFirstTouch` skipped only the level's own source candles by open time; there was no "strictly after activation" rule tied to the confirmation close. | Ambiguous first-return definition. | First return starts at the activation instant (confirmation close). |

## Retired claims
Every earlier diagnostic figure derived from `research/first-touch`, `PROPOSED_SWING_DETECTOR`,
unconverted server-clock timestamps or the `collector/reports/level-review` case studies (including any
"51/72"-style counts) is retired. None is evidence about `xauusd-h4-confirmed-retest-v1`.
