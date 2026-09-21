# v2 timestamp interpretation — supported vs. assumed

Reusing existing evidence only (no new live measurement taken for this task — the 2026-09-15
verification pass and candle-sync-fix follow-up already established what's below):

- **Supported, live-verified:** stored XAUUSD/EURUSD H4/M1 bar times are broker-server wall-clock
  digits mislabeled as UTC; the broker's IANA zone is `EET`. Live-verified for **EU summer time
  (EEST, UTC+3)** as of 2026-09-15 (`../confirmed-retest/verification/mt5-live-time-evidence.json`,
  `.../candle-sync-fix/proof.json`) — a position-based fetch with no datetime argument read
  exactly +3.000h vs. an externally verified clock.
- **Assumed, not live-verified:** the winter offset (EET, UTC+2) is inferred only from historical
  daily-break-time arithmetic (`../confirmed-retest/verification/VERIFICATION_REPORT.md` §1.5,
  `break-arithmetic.sql`) — the break sits at a constant New York time straight through the
  US/EU DST-mismatch weeks, which is consistent with EET/EEST but was never checked against an
  independently-timed live observation taken in winter, because today is deep in EU summer DST.

## What this means for v2's results

- **Formation diagnostics** (pivot/retest/confirmation counts, the full funnel in `REPORT.md`) use
  only H4 bar identity and price — they do not filter by session window at all, so they carry no
  time-basis uncertainty beyond the EET/EEST re-interpretation itself (supported year-round: DST
  transition dates are a calendar fact, not something that needed a live check — only the *raw
  offset value*, not *when it changes*, is unverified for winter).
- **Session-window-filtered results** (`eligible` events restricted to 04:00–12:00 Asia/Beirut,
  and the one-position paper simulation, which only ever acts on eligible events) ARE sensitive to
  which raw UTC offset applies at touch time. Any touch whose true Beirut wall-clock hour sits near
  a window boundary AND whose Beirut-local time depends on distinguishing EET (+2) from EEST (+3)
  — i.e. touches occurring in a winter month, since the EET/EEST *transition* dates themselves are
  not in question, only the correctness of applying EET's known winter offset without a live
  check — carry the assumption-dependent label described above, not "verified".
- Per instruction: the interpretation that yields the better result was never selected — the SAME
  EET/EEST conversion (`SPEC.data.brokerServerTimezone: 'EET'`, verified year-round DST calendar,
  offset value live-checked only in summer) is applied uniformly to every bar regardless of season
  or of which result it produces. No alternative interpretation was computed or compared.
- No historical timestamps were bulk-rewritten; the unrelated breakout engine's own separate,
  already-documented timestamp issue was not touched.
