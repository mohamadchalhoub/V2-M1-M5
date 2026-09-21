# Friend's Gold (XAUUSD) Strategy — Rules vs Implementation vs Delegated Choices

Status: initial pass, written before any code changes for this task. Confirmed-retest v2
(`backend/src/research/confirmed-retest-v2/`) is the reuse base. As of this pass it is
**research/watch-only only** — grep-confirmed no order/execution import anywhere in that
directory (`confirmed-retest.controller.ts:14` and v2 spec's own provenance note both state
"NO ORDER PATH"). Building the demo execution pipeline (scheduler, MT5 executor, occupancy
lock, risk gating, dashboard live-position views) is net-new work, not something to "reuse" —
noted here so the rule table isn't mistaken for evidence that entries are already wired.

| # | Friend rule (verbatim intent) | Existing implementation | Delegated choice | Code location |
|---|---|---|---|---|
| 1 | Instrument: XAUUSD | Symbol validated via broker metadata capture | Reuse existing `capture_contract_metadata.py` symbol validation | `collector/app/capture_contract_metadata.py` |
| 2 | H4 for S/R, M1 for touch/outcome, D1 descriptive only | v2 uses H4 pivots+retest, M1 outcome resolution, D1 tag descriptive | none | `confirmed-retest-v2/levels.ts`, `outcome.ts`, `types.ts` (D1 tag) |
| 3 | Level = first qualifying S/R outside/on candle bodies, tested + rejected | v1/v2 pivot (2-left/2-right) + $10 rejection-close qualification + body filter | none (frozen numeric params inherited) | `levels.ts`, `spec.ts` |
| 4 | Exact touch = returning to fixed L, not requiring 2 identical pivots | v2's retest-of-L model (this is exactly v2's stated change from v1) | none — this is why v2, not v1, is the base | `levels.ts` §3 "Retest candle R" |
| 5 | After a break, new qualifying level, no bounce-trade on broken level | Lifecycle state machine: ACTIVE → RETIRED_UNTIL_BREAK → BROKEN → new generation | Retirement rule: resistance retires on H4 body close strictly above L, support strictly below (delegated default, matches spec intent) | `levels.ts` dedup/generation logic |
| 6 | Direction: buy support touch, sell resistance touch, no breakouts | Implemented; no breakout entry path exists | none | `levels.ts`, `outcome.ts` |
| 7 | Entry window 04:00–12:00 Asia/Beirut, EET/EEST correct | Reused confirmed-retest `time.ts` (live-verified EEST conversion) | Winter EET offset still unverified by live measurement — carried as documented assumption, NOT resolved by this task yet | `confirmed-retest-v2/time.ts`, `TIME_EVIDENCE.md` |
| 8 | First touch = first return after level establishment, not first-per-day | v1/v2 event/lifecycle model already implements single first-return consumption, in and out of window | none | `replay.ts` |
| 9 | TP/SL = $10 price movement each, executable-boundary-first, stopped stays loss | `outcome.ts` implements this exactly | none | `outcome.ts` |
| 10 | No noon closure, no max hold, count both sides of noon, unresolved stays unresolved at data end | Implemented in `outcome.ts`/`replay.ts` | none | `outcome.ts`, `replay.ts` |
| 11 | Wick touch counts (not body-only); M1 can't always resolve intrabar sequence → mark AMBIGUOUS | Implemented: `low<=L<=high` touch test; ambiguity flagging exists in outcome resolution | none | `outcome.ts` |
| 12 | One active trade per symbol at a time (incl. manual/other-strategy/pending/UNKNOWN) | **NOT YET IMPLEMENTED** — no execution path exists at all yet | Delegated: implement as a persistent DB-backed reservation checked against live broker position/order/deal state before submission | not yet created — planned: new `gold-execution/` module |
| 13 | User-controlled fixed volumes (XAUUSD 0.01, EURUSD 0.12), validate broker step, no silent resize | Not yet wired for gold execution (EURUSD path may partially exist in legacy strategy code — not yet audited this task) | Delegated: reject and log (never resize) on invalid broker step/min/max | planned |
| 14 | Risk caps (0.5%/1%/2%/5%) unweakened, real equity not assumed | v2's *paper simulation* already applies these caps in backtest | Not yet wired into a live pre-trade gate for actual demo orders | `paper.ts` (backtest-only today) |
| 15 | EURUSD legacy strategy stays separate, inactive, but its collection/volume/occupancy keep working | Not yet audited/confirmed this task | Delegated: dashboard must show "EURUSD strategy inactive" explicitly | pending |
| 16 | DEMO-only execution, never real-money fallback | No execution path exists yet at all (research-only), so trivially true today | Delegated: new executor must hard-check `trade_mode==DEMO` before first order and refuse otherwise | planned |

## Not yet done (tracked in `IMPLEMENTATION_CHECKPOINT.md`)
Sections 3 (versioned v2.1/live spec), 5 (occupancy + risk live wiring), 6D/E (execution,
scheduler, controls), 7 (three-output historical evaluation for the gold-specific rule set),
8 (verification + demo activation), and the remaining handoff docs are not complete as of
this pass. See the checkpoint file for exact next steps and current blockers.
