// Read-only evidence script — no source files modified, no suite rerun.
// Answers the follow-up question: is h4-trend-h1-breakout-v1's entry-window
// shift already fixed, still affected, or was it misdiagnosed?
//
// backtest.ts:133 and :375 call isWithinEntryWindow(candle.openTime).
// candle.openTime comes straight from historical-candle.service.ts's
// getCandlesInRange(), which applies NO correction — it is the stored RAW
// value, which (per collector/app/mt5_client.py's get_candles(), and
// deliberately UNCHANGED by the 2026-09-15 collection query-bound fix,
// which only touched sync latency, not the stored value's labeling) is
// broker-server wall-clock digits mislabeled as UTC, not true UTC.
// isWithinEntryWindow() (schedule.ts:75) treats its argument as true UTC
// and converts it to Beirut local via IANA Asia/Beirut. Feeding it the raw
// mislabeled value shifts the effective window by the broker's own UTC
// offset (currently +3h, EEST).
import { isWithinEntryWindow, getBeirutWallClock } from '../../../../src/trend-breakout/schedule';

function fmt(d: Date) { return d.toISOString(); }

// A concrete stored (raw, mislabeled) H1 candle open time — exactly what
// candle.openTime holds and what backtest.ts feeds straight into
// isWithinEntryWindow(). Broker offset +3h is this session's own live
// measurement (mt5-live-time-evidence.json / candle-sync-fix/proof.json),
// not assumed.
const storedRawOpenTime = new Date('2026-07-15T02:30:00.000Z');
const brokerOffsetHoursSummer = 3;
const trueUtcOpenTime = new Date(storedRawOpenTime.getTime() - brokerOffsetHoursSummer * 3600_000);

console.log('=== What backtest.ts actually does ===');
console.log('candle.openTime (stored, raw, mislabeled):', fmt(storedRawOpenTime));
console.log('  Beirut wall clock as computed by backtest.ts:', JSON.stringify(getBeirutWallClock(storedRawOpenTime)));
console.log('  isWithinEntryWindow(candle.openTime) -> USED BY THE BACKTEST:', isWithinEntryWindow(storedRawOpenTime));

console.log('\n=== What is actually true ===');
console.log('true UTC instant this bar really opened at:', fmt(trueUtcOpenTime));
console.log('  correct Beirut wall clock:', JSON.stringify(getBeirutWallClock(trueUtcOpenTime)));
console.log('  isWithinEntryWindow(true UTC) -> CORRECT:', isWithinEntryWindow(trueUtcOpenTime));

console.log('\n=== Verdict ===');
const used = isWithinEntryWindow(storedRawOpenTime);
const correct = isWithinEntryWindow(trueUtcOpenTime);
console.log(used === correct
  ? 'This example happens to agree (not proof the bug is absent — see the report for boundary-crossing cases).'
  : `MISMATCH: backtest.ts would decide '${used ? 'within window' : 'outside window'}' for a bar that is actually '${correct ? 'within window' : 'outside window'}'. Confirms the shift is live in the code, unaffected by the 2026-09-15 collection fix.`);
