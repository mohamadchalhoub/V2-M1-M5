/**
 * Verifies this project's RSI against MetaTrader's OWN output.
 *
 * Usage: npm run xauusd-rsi:verify-rsi -- [path-to-rsi_reference.csv]
 *
 * ## Why the CSV
 *
 * The MetaTrader5 Python API exposes no indicator functions — `copy_rates_*`
 * returns bars, and there is no `iRSI`. The only way to obtain the terminal's
 * own indicator values is to ask the terminal, so `MQL5/Scripts/RsiReference.mq5`
 * runs inside MetaTrader, calls `iRSI(symbol, PERIOD_M1, 5, PRICE_CLOSE)`, and
 * writes the bars alongside the values it computed for them.
 *
 * This script then recomputes RSI over exactly those closes with the engine
 * the strategy actually uses, and compares. So the comparison is against the
 * terminal, not against a second implementation of the same formula.
 *
 * ## What it checks
 *
 * 1. Agreement across the whole series.
 * 2. Flat-price behaviour, on real runs of unchanged closes found in the data.
 * 3. Forming-bar projection against the committed value for the same price.
 *
 * It fixes defects by reporting them, never by adding a filter.
 */
import { readFileSync } from 'node:fs';
import { commitClosedBar, createRsiState, currentRsi, projectRsi, rsiFromAverages } from '../src/xauusd-rsi/rsi';
import { SPEC } from '../src/xauusd-rsi/spec';

const DEFAULT_CSV =
  'C:\\Users\\user\\AppData\\Roaming\\MetaQuotes\\Terminal\\D0E8209F77C8CF37AD8BF550E51FF075\\MQL5\\Files\\rsi_reference.csv';

interface Row {
  timeSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  mt5Rsi: number;
}

function loadRows(path: string): Row[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length < 6) continue;
    rows.push({
      timeSec: Number(parts[0]),
      open: Number(parts[1]),
      high: Number(parts[2]),
      low: Number(parts[3]),
      close: Number(parts[4]),
      mt5Rsi: Number(parts[5]),
    });
  }
  return rows;
}

function main() {
  const path = process.argv[2] ?? DEFAULT_CSV;
  const rows = loadRows(path);

  console.log('='.repeat(78));
  console.log('RSI verification against MetaTrader 5\u2019s own iRSI output');
  console.log('='.repeat(78));
  console.log(`\nSource: ${path}`);
  console.log(`Bars:   ${rows.length}`);
  console.log(`First:  ${new Date(rows[0].timeSec * 1000).toISOString()}`);
  console.log(`Last:   ${new Date(rows[rows.length - 1].timeSec * 1000).toISOString()}`);
  console.log(`Settings compared: period ${SPEC.rsi.period}, applied price ${SPEC.rsi.appliedPrice} (MT5: PRICE_CLOSE)`);

  // --- 1. Whole-series agreement ------------------------------------------
  let state = createRsiState(SPEC.rsi.period);
  const diffs: Array<{ i: number; mine: number; mt5: number; diff: number }> = [];
  const mine: Array<number | null> = [];

  for (let i = 0; i < rows.length; i += 1) {
    state = commitClosedBar(state, rows[i].close);
    const value = currentRsi(state);
    mine.push(value);
    if (value === null) continue;
    // The first values after seeding differ legitimately: MT5's buffer has
    // been folding this symbol's entire loaded history, while this run starts
    // from the first bar in the file. Wilder's average converges, so the early
    // bars are reported separately rather than counted as disagreement.
    diffs.push({ i, mine: value, mt5: rows[i].mt5Rsi, diff: Math.abs(value - rows[i].mt5Rsi) });
  }

  const converged = diffs.filter((d) => d.i >= 300);
  const maxAll = diffs.reduce((m, d) => Math.max(m, d.diff), 0);
  const maxConverged = converged.reduce((m, d) => Math.max(m, d.diff), 0);
  const meanConverged = converged.reduce((s, d) => s + d.diff, 0) / Math.max(1, converged.length);

  console.log('\n## 1. Whole-series agreement\n');
  console.log(`  Compared bars:                 ${diffs.length}`);
  console.log(`  Max |difference| (all bars):   ${maxAll.toExponential(3)}`);
  console.log(`  Max |difference| (after 300):  ${maxConverged.toExponential(3)}`);
  console.log(`  Mean |difference| (after 300): ${meanConverged.toExponential(3)}`);
  console.log('  Bars before 300 are excluded from the headline figure because this run seeds');
  console.log("  from the first bar in the file while the terminal's own buffer has been folding");
  console.log('  the symbol\u2019s full loaded history. Wilder\u2019s recursive average converges, so the');
  console.log('  early gap closes rather than persisting.');

  const worst = [...converged].sort((a, b) => b.diff - a.diff).slice(0, 3);
  if (worst.length > 0) {
    console.log('\n  Worst converged disagreements:');
    for (const w of worst) {
      console.log(
        `    bar ${w.i} ${new Date(rows[w.i].timeSec * 1000).toISOString()} close=${rows[w.i].close} ` +
          `mt5=${w.mt5.toFixed(10)} mine=${w.mine.toFixed(10)} diff=${w.diff.toExponential(3)}`,
      );
    }
  }

  const VERDICT_TOLERANCE = 1e-6;
  console.log(
    `\n  VERDICT: ${maxConverged <= VERDICT_TOLERANCE ? 'MATCHES MT5' : 'DISAGREES WITH MT5'} ` +
      `(tolerance ${VERDICT_TOLERANCE.toExponential(0)})`,
  );

  // --- 2. Flat-price behaviour --------------------------------------------
  console.log('\n## 2. Flat-price behaviour\n');
  console.log('  The claim under test: MT5 reports RSI 100 when average loss is zero, so a run');
  console.log(`  of ${SPEC.rsi.period} unchanged closes reads 100. Checked against real runs of`);
  console.log('  unchanged closes in this data rather than asserted from the published formula.');

  const flatRuns: Array<{ start: number; length: number }> = [];
  let runStart = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].close === rows[i - 1].close) continue;
    const length = i - runStart;
    if (length >= 2) flatRuns.push({ start: runStart, length });
    runStart = i;
  }

  const longRuns = flatRuns.filter((r) => r.length >= SPEC.rsi.period).sort((a, b) => b.length - a.length);
  console.log(`\n  Runs of >=2 unchanged closes: ${flatRuns.length}`);
  console.log(`  Runs of >=${SPEC.rsi.period} unchanged closes: ${longRuns.length}`);

  if (longRuns.length === 0) {
    console.log('\n  No run of unchanged closes long enough to drive average loss to zero occurs in');
    console.log('  this sample, so the terminal cannot be asked about it directly here. What CAN');
    console.log('  be stated from the data is below; the fully-flat case is addressed after it.');
  } else {
    console.log('\n  Longest runs, with MT5\u2019s own value at the end of each:');
    for (const run of longRuns.slice(0, 5)) {
      const endIdx = run.start + run.length - 1;
      console.log(
        `    bars ${run.start}..${endIdx} (${run.length} unchanged closes @ ${rows[endIdx].close}) ` +
          `mt5=${rows[endIdx].mt5Rsi.toFixed(6)} mine=${(mine[endIdx] ?? Number.NaN).toFixed(6)}`,
      );
    }
    const allHundred = longRuns.every((r) => Math.abs(rows[r.start + r.length - 1].mt5Rsi - 100) < 1e-6);
    console.log(
      `\n  MT5 reported exactly 100 at the end of every such run: ${allHundred ? 'YES' : 'NO'}`,
    );
  }

  // The zero-loss convention itself, stated directly from this implementation.
  console.log('\n  This implementation\u2019s zero-denominator convention:');
  console.log(`    rsiFromAverages(gain=1, loss=0) = ${rsiFromAverages(1, 0)}`);
  console.log(`    rsiFromAverages(gain=0, loss=0) = ${rsiFromAverages(0, 0)}   <- fully flat series`);
  console.log(`    rsiFromAverages(gain=0, loss=1) = ${rsiFromAverages(0, 1)}`);
  console.log('    These reproduce RSI.mq5\u2019s own branch: if average loss is non-zero use the');
  console.log('    standard formula, else report 100 — including when average gain is also 0.');

  // --- 3. Synthetic series -------------------------------------------------
  console.log('\n## 3. Synthetic series (this implementation)\n');
  console.log('  MetaTrader\u2019s iRSI computes over a symbol\u2019s chart data, so an arbitrary');
  console.log('  synthetic array cannot be fed to it. These are this implementation\u2019s outputs,');
  console.log('  reported for the specific cases asked about; the terminal comparison above is');
  console.log('  what establishes the implementation is faithful in the first place.');

  const scenario = (label: string, closes: number[]) => {
    let s = createRsiState(SPEC.rsi.period);
    for (const c of closes) s = commitClosedBar(s, c);
    const v = currentRsi(s);
    console.log(`    ${label.padEnd(46)} -> ${v === null ? 'null (seeding)' : v.toFixed(6)}`);
  };

  scenario('entirely flat initialised history', [2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]);
  scenario('rising, then five flat closes', [1990, 1992, 1994, 1996, 1998, 2000, 2000, 2000, 2000, 2000]);
  scenario('mixed, then five flat closes', [2000, 2004, 1998, 2003, 1999, 2002, 2002, 2002, 2002, 2002]);
  scenario('falling, then five flat closes', [2010, 2008, 2006, 2004, 2002, 2000, 2000, 2000, 2000, 2000]);

  console.log('\n    Note the third case: a mixed history leaves a NON-zero smoothed average loss,');
  console.log('    which decays but never reaches zero, so five flat closes raise RSI without');
  console.log('    pinning it to 100. Only a history with no downward change at all does that.');

  // --- 4. Forming bar vs completed bar ------------------------------------
  console.log('\n## 4. Forming-bar projection vs completed bar\n');

  let fs = createRsiState(SPEC.rsi.period);
  for (const c of rows.slice(0, 400).map((r) => r.close)) fs = commitClosedBar(fs, c);

  const nextClose = rows[400].close;
  const projected = projectRsi(fs, nextClose);
  const committed = currentRsi(commitClosedBar(fs, nextClose));
  console.log(`  Projection at the forming bar\u2019s price:  ${projected?.toFixed(10)}`);
  console.log(`  Value once that price closes the bar:   ${committed?.toFixed(10)}`);
  console.log(`  Identical: ${projected === committed ? 'YES' : 'NO'}`);
  console.log(`  MT5\u2019s own value for that bar:           ${rows[400].mt5Rsi.toFixed(10)}`);
  console.log(`  |projection - MT5|:                      ${Math.abs((projected ?? 0) - rows[400].mt5Rsi).toExponential(3)}`);

  const before = { ...fs };
  projectRsi(fs, 9999);
  console.log(`  Projection left committed state unchanged: ${JSON.stringify(before) === JSON.stringify(fs) ? 'YES' : 'NO'}`);

  const a = projectRsi(fs, nextClose);
  const b = projectRsi(fs, nextClose);
  const c = projectRsi(fs, nextClose);
  console.log(`  Repeated projection is stable (tick density has no effect): ${a === b && b === c ? 'YES' : 'NO'}`);

  console.log('\nDone.');
  if (maxConverged > VERDICT_TOLERANCE) process.exitCode = 1;
}

main();
