/**
 * Standalone source-of-truth reconciliation against a real XTB xlsx export —
 * NOT wired into the live import path (xtb-import.service.ts stays exactly
 * as-is; this never writes to any database). Uses the SAME, already-tested
 * `parseXtbClosedPositionsXlsx` the real importer uses for the closed-
 * positions sheet, so "does the workbook reconcile" and "does the importer
 * parse it correctly" are the same question, not two.
 *
 * The "CASH OPERATION HISTORY" sheet (deposits/withdrawals/interest/interest
 * tax/close-trade postings) has no import path anywhere in this app — this
 * script parses it independently, for verification only, since the audit
 * asks to reconcile the account's cash flow against its ending balance, not
 * to add a new production feature.
 *
 * Run: npx tsx scripts/reconcile-xtb-workbook.ts <path-to-xlsx>
 */
import ExcelJS from 'exceljs';
import { parseXtbClosedPositionsXlsx } from '../src/xtb-import/xtb-csv-parser';

interface CashOp {
  id: string;
  type: string;
  time: Date | null;
  comment: string;
  symbol: string | null;
  amount: number;
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && 'richText' in value) return (value as any).richText.map((t: any) => t.text).join('');
  if (typeof value === 'object' && 'text' in value) return String((value as any).text);
  return String(value);
}

function rowStrings(row: ExcelJS.Row, max: number): string[] {
  const out: string[] = [];
  for (let c = 1; c <= max; c++) out[c - 1] = cellToString(row.getCell(c).value);
  return out;
}

/** Same header-scan convention as parseXtbClosedPositionsXlsx, applied to the cash-operations sheet's own real columns (ID, Type, Time, Comment, Symbol, Amount). */
function parseCashOperations(sheet: ExcelJS.Worksheet): CashOp[] {
  const REQUIRED = ['id', 'type', 'time', 'amount'];
  let headerRow = -1;
  let headers: string[] = [];
  for (let r = 1; r <= Math.min(sheet.rowCount, 50); r++) {
    const cells = rowStrings(sheet.getRow(r), 8).map((h) => h.trim());
    const normalized = cells.map((h) => h.toLowerCase());
    if (REQUIRED.every((f) => normalized.includes(f))) {
      headerRow = r;
      headers = cells;
      break;
    }
  }
  if (headerRow === -1) throw new Error('No recognizable header row found in the cash-operations sheet');

  const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name);
  const iId = idx('id');
  const iType = idx('type');
  const iTime = idx('time');
  const iComment = idx('comment');
  const iSymbol = idx('symbol');
  const iAmount = idx('amount');

  const ops: CashOp[] = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells = rowStrings(row, headers.length);
    if (cells.every((v) => v === '')) continue;
    if (!cells[iId]) continue;
    const timeRaw = row.getCell(iTime + 1).value;
    ops.push({
      id: cells[iId],
      type: cells[iType]?.trim() ?? '',
      time: timeRaw instanceof Date ? timeRaw : timeRaw ? new Date(String(timeRaw)) : null,
      comment: cells[iComment] ?? '',
      symbol: cells[iSymbol]?.trim() || null,
      amount: Number(cells[iAmount]) || 0,
    });
  }
  return ops;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: npx tsx scripts/reconcile-xtb-workbook.ts <path-to-xlsx>');
    process.exit(1);
  }

  const fs = await import('node:fs/promises');
  const buffer = await fs.readFile(filePath);

  // ---- 1. Closed positions — via the REAL, already-tested importer parser ----
  const { rows, errors } = await parseXtbClosedPositionsXlsx(buffer);
  console.log(`\n=== CLOSED POSITION HISTORY (via parseXtbClosedPositionsXlsx — the real importer's own parser) ===`);
  console.log(`Parsed rows: ${rows.length}   Parse errors: ${errors.length}`);
  if (errors.length > 0) console.log(errors.slice(0, 5));

  const eur = rows.filter((r) => r.symbol === 'EURUSD');
  const netOf = (r: (typeof rows)[number]) => r.profit + r.commission + r.swap;

  function summarize(label: string, set: typeof rows) {
    const wins = set.filter((r) => netOf(r) > 0).length;
    const losses = set.filter((r) => netOf(r) < 0).length;
    const be = set.filter((r) => netOf(r) === 0).length;
    const gross = set.reduce((s, r) => s + r.profit, 0);
    const swap = set.reduce((s, r) => s + r.swap, 0);
    const comm = set.reduce((s, r) => s + r.commission, 0);
    const net = gross + swap + comm;
    console.log(`\n-- ${label} --`);
    console.log(`n=${set.length}  wins=${wins} losses=${losses} breakeven=${be}  winRate=${((wins / set.length) * 100).toFixed(4)}%`);
    console.log(`gross=${gross.toFixed(2)}  swap=${swap.toFixed(2)}  commission=${comm.toFixed(2)}  net=${net.toFixed(2)}`);
    console.log(`profitFactor(net)=${(set.filter((r) => netOf(r) > 0).reduce((s, r) => s + netOf(r), 0) / Math.abs(set.filter((r) => netOf(r) < 0).reduce((s, r) => s + netOf(r), 0))).toFixed(5)}`);
  }
  summarize('Entire account', rows);
  summarize('EURUSD only', eur);

  const closeTimes = eur.map((r) => r.closeTime.getTime()).sort((a, b) => a - b);
  console.log(`\nEURUSD close-time range: ${new Date(closeTimes[0]).toISOString()} .. ${new Date(closeTimes.at(-1)!).toISOString()}`);
  const allCloseTimes = rows.map((r) => r.closeTime.getTime()).sort((a, b) => a - b);
  console.log(`All-symbol close-time range: ${new Date(allCloseTimes[0]).toISOString()} .. ${new Date(allCloseTimes.at(-1)!).toISOString()}`);

  const withSlTp = eur.filter((r) => r.stopLoss !== null && r.takeProfit !== null);
  console.log(`\nEURUSD with both SL+TP recorded: ${withSlTp.length}`);
  const POINT = 0.00001;
  const slDistances = withSlTp.map((r) => Math.abs((r.stopLoss! - r.openPrice) / POINT));
  const tpDistances = withSlTp.map((r) => Math.abs((r.takeProfit! - r.openPrice) / POINT));
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  console.log(`  avg |SL-open| = ${avg(slDistances).toFixed(2)}pt   avg |TP-open| = ${avg(tpDistances).toFixed(2)}pt`);
  const directionallyValid = withSlTp.filter((r) => {
    const slSigned = (r.stopLoss! - r.openPrice) / POINT;
    const tpSigned = (r.takeProfit! - r.openPrice) / POINT;
    return r.side === 'BUY' ? slSigned < 0 && tpSigned > 0 : slSigned > 0 && tpSigned < 0;
  }).length;
  console.log(`  directionally valid (SL/TP on textbook-correct side of entry for direction): ${directionallyValid}/${withSlTp.length}`);

  const byYear = new Map<string, { n: number; net: number; wins: number }>();
  for (const r of eur) {
    const y = r.closeTime.getUTCFullYear().toString();
    const cur = byYear.get(y) ?? { n: 0, net: 0, wins: 0 };
    cur.n++;
    cur.net += netOf(r);
    if (netOf(r) > 0) cur.wins++;
    byYear.set(y, cur);
  }
  console.log(`\nEURUSD by closing year:`);
  for (const [y, { n, net, wins }] of [...byYear.entries()].sort()) {
    console.log(`  ${y}: n=${n}  net=${net.toFixed(2)}  winRate=${((wins / n) * 100).toFixed(2)}%`);
  }

  const openDates = new Map<string, number>();
  for (const r of eur) {
    const d = r.openTime.toISOString().slice(0, 10);
    openDates.set(d, (openDates.get(d) ?? 0) + 1);
  }
  const multi = [...openDates.values()].filter((n) => n > 1).length;
  console.log(`\nEURUSD distinct open dates: ${openDates.size}  multi-open dates: ${multi}  max on one date: ${Math.max(...openDates.values())}`);

  const flagged = rows.find((r) => r.orderId === '1651801405');
  if (flagged) {
    console.log(`\nPosition 1651801405: symbol=${flagged.symbol} volume=${flagged.volume} closeTime=${flagged.closeTime.toISOString()} net=${netOf(flagged).toFixed(2)} closeOrigin=${flagged.raw['Close origin']} SL=${flagged.stopLoss}`);
  }

  const closeOriginIdx = 'Close origin';
  const originCounts = new Map<string, number>();
  for (const r of rows) {
    const v = r.raw[closeOriginIdx] ?? '(blank)';
    originCounts.set(v, (originCounts.get(v) ?? 0) + 1);
  }
  console.log(`\nDistinct "Close origin" values (all ${rows.length} positions):`);
  for (const [v, n] of [...originCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${JSON.stringify(v)}: ${n}`);

  const soCommentAll = rows.filter((r) => /\[S\/O/i.test(r.comment ?? '')).length;
  const soCommentEur = eur.filter((r) => /\[S\/O/i.test(r.comment ?? '')).length;
  console.log(`\nPositions whose Comment starts with "[S/O" (margin stop-out marker, distinct from Close origin): all=${soCommentAll} EURUSD=${soCommentEur}`);

  // ---- 2. Cash operations — deposits/withdrawals/interest/tax/close-trade ----
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const cashSheet = workbook.worksheets.find((s) => /cash.*operation/i.test(s.name));
  if (!cashSheet) {
    console.log('\nNo CASH OPERATION HISTORY sheet found.');
  } else {
    const ops = parseCashOperations(cashSheet);
    console.log(`\n=== CASH OPERATION HISTORY ===`);
    console.log(`Total rows parsed: ${ops.length}`);
    const byType = new Map<string, { n: number; sum: number }>();
    for (const op of ops) {
      const t = op.type.toLowerCase();
      const cur = byType.get(t) ?? { n: 0, sum: 0 };
      cur.n++;
      cur.sum += op.amount;
      byType.set(t, cur);
    }
    for (const [type, { n, sum }] of [...byType.entries()].sort()) {
      console.log(`  ${type.padEnd(20)} n=${n}  sum=${sum.toFixed(2)}`);
    }
    const closeTrade = ops.filter((o) => o.type.toLowerCase() === 'close trade');
    const closeTradeEur = closeTrade.filter((o) => o.symbol === 'EURUSD');
    console.log(`\n"close trade" cash postings: total=${closeTrade.length}  EURUSD=${closeTradeEur.length}`);
    console.log(`Sum of ALL "close trade" postings: ${closeTrade.reduce((s, o) => s + o.amount, 0).toFixed(2)}`);

    const deposits = ops.filter((o) => o.type.toLowerCase() === 'deposit').reduce((s, o) => s + o.amount, 0);
    const withdrawals = ops.filter((o) => o.type.toLowerCase() === 'withdrawal').reduce((s, o) => s + o.amount, 0);
    const interest = ops.filter((o) => o.type.toLowerCase().includes('interest') && !o.type.toLowerCase().includes('tax')).reduce((s, o) => s + o.amount, 0);
    const interestTax = ops.filter((o) => o.type.toLowerCase().includes('interest') && o.type.toLowerCase().includes('tax')).reduce((s, o) => s + o.amount, 0);
    // Correction: "close trade" cash postings carry GROSS P/L only — swap is
    // its own SEPARATE cash-operation line (199 individual postings here),
    // not folded into each close-trade posting. Missing this line was a
    // real bug in this script's first version (produced 457.72, not 18.19)
    // — fixed by including it explicitly, not by adjusting other terms to
    // force a match.
    const grossTradingProfit = closeTrade.reduce((s, o) => s + o.amount, 0);
    const swapPostings = ops.filter((o) => o.type.toLowerCase() === 'swap').reduce((s, o) => s + o.amount, 0);
    const rolloverPostings = ops.filter((o) => o.type.toLowerCase() === 'rollover').reduce((s, o) => s + o.amount, 0);
    console.log(`\nCash reconciliation:`);
    console.log(`  deposits=${deposits.toFixed(2)}  withdrawals=${withdrawals.toFixed(2)}  interest=${interest.toFixed(2)}  interestTax=${interestTax.toFixed(2)}`);
    console.log(`  gross trading profit (sum of close-trade postings)=${grossTradingProfit.toFixed(2)}`);
    console.log(`  swap postings (separate cash-ledger line)=${swapPostings.toFixed(2)}`);
    console.log(`  rollover postings (separate cash-ledger line, expected 0)=${rolloverPostings.toFixed(2)}`);
    const computedBalance = deposits + withdrawals + grossTradingProfit + swapPostings + rolloverPostings + interest + interestTax;
    console.log(`  computed ending balance = deposits + withdrawals + grossTradingProfit + swap + rollover + interest + interestTax`);
    console.log(`                          = ${computedBalance.toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
