import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

/**
 * The adapter boundary (Phase 0 §12: "the adapter-boundary design from
 * Revision 0 stands as-is"). This is the ONE file that knows anything about
 * XTB's export column names — everything downstream (xtb-import.service.ts)
 * works with this normalized shape only. Column names below are based on
 * XTB/xStation5's commonly-documented "closed positions" statement export;
 * **this has not been verified against a real exported file** (Phase 0's
 * own walking-skeleton step 14 explicitly expects that verification to
 * happen against the trader's real account — it's the one piece of Phase 8
 * that genuinely needs you, not just more autonomous work). If real column
 * names differ, only this file needs to change.
 */
export interface XtbClosedPositionRow {
  /** XTB's own order/position identifier — the natural key for dedup (mapped to Trade.externalTradeId with an -IN/-OUT suffix, xtb-import.service.ts). */
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: number;
  openTime: Date;
  openPrice: number;
  closeTime: Date;
  closePrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  commission: number;
  swap: number;
  /** Net P/L as reported by XTB for the closed position. */
  profit: number;
  comment: string | null;
  /** The exact original cell values for this row, verbatim — preserved in Trade.rawPayload for both synthetic IN/OUT rows (Phase 0 §04/§12, Req. 10). */
  raw: Record<string, string>;
}

export interface XtbParseError {
  rowNumber: number;
  message: string;
  raw: Record<string, string>;
}

export interface XtbParseResult {
  rows: XtbClosedPositionRow[];
  errors: XtbParseError[];
}

// Each canonical field maps to every column-name spelling this parser
// currently recognizes (case/whitespace-insensitive, matched after
// normalizeHeader). Extend this list once a real export reveals the actual
// column names — that is the ENTIRE fix, nothing else in this module
// (or any caller) needs to change.
const COLUMN_ALIASES: Record<string, string[]> = {
  orderId: ['order', 'position', 'id', 'ticket', 'orderid', 'positionid'],
  symbol: ['symbol', 'instrument'],
  side: ['type', 'side', 'direction'],
  volume: ['volume', 'vol', 'lots'],
  openTime: ['opentime', 'opendate', 'timeopen'],
  openPrice: ['openprice', 'priceopen'],
  closeTime: ['closetime', 'closedate', 'timeclose'],
  closePrice: ['closeprice', 'priceclose'],
  stopLoss: ['sl', 'stoploss'],
  takeProfit: ['tp', 'takeprofit'],
  commission: ['commission', 'commissions'],
  swap: ['swap', 'rollover', 'swaps'],
  profit: ['profit', 'grosspl', 'netpl', 'grossprofit', 'netprofit', 'marketvalue'],
  comment: ['comment', 'comments'],
};

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Builds a lookup from canonical field name → actual header string present in this file. */
function resolveColumns(headers: string[]): Partial<Record<keyof typeof COLUMN_ALIASES, string>> {
  const normalized = headers.map((h) => ({ original: h, normalized: normalizeHeader(h) }));
  const resolved: Partial<Record<string, string>> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const match = normalized.find((h) => aliases.includes(h.normalized));
    if (match) resolved[field] = match.original;
  }
  return resolved;
}

function parseNumber(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  // XTB exports have been known to use thousands separators; strip anything
  // that isn't a digit, minus sign, or decimal point.
  const cleaned = value.replace(/[^\d.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '' || value.trim() === '0') return null;
  const parsed = parseNumber(value);
  return parsed === 0 ? null : parsed;
}

function parseDate(value: string | undefined): Date | null {
  if (!value || value.trim() === '') return null;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseSide(value: string | undefined): 'BUY' | 'SELL' | null {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'BUY' || normalized === 'SELL') return normalized;
  if (normalized === 'B') return 'BUY';
  if (normalized === 'S') return 'SELL';
  return null;
}

const REQUIRED_FIELDS: (keyof typeof COLUMN_ALIASES)[] = [
  'orderId',
  'symbol',
  'side',
  'volume',
  'openTime',
  'openPrice',
  'closeTime',
  'closePrice',
  'profit',
];

export function parseXtbClosedPositionsCsv(csvText: string): XtbParseResult {
  const records: Record<string, string>[] = parse(csvText, {
    columns: true,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  return parseXtbClosedPositionRecords(records, 'CSV');
}

/**
 * XTB/xStation5 xlsx exports (verified against a real "closed positions"
 * export — see XTB_IMPORT_SPEC.md §4's addendum) are a formatted report, not
 * a plain table: several title/summary rows precede the real header, and a
 * workbook has multiple sheets (closed positions, open positions, pending
 * orders, cash operations). This scans for the sheet/row that actually looks
 * like the closed-positions header (every REQUIRED_FIELDS canonical column
 * resolves) rather than assuming row 1 of sheet 1 — the same alias-matching
 * `resolveColumns` the CSV path already uses, so a real column-name
 * difference only ever needs fixing in one place (COLUMN_ALIASES above).
 */
export async function parseXtbClosedPositionsXlsx(buffer: Buffer): Promise<XtbParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  // Prefer a sheet whose name suggests closed positions; scan every sheet
  // (in case a broker names it differently) rather than assuming sheet 1 —
  // XTB's own export puts three OTHER report sheets (open positions,
  // pending orders, cash operations) in the same workbook.
  const sheets = [
    ...workbook.worksheets.filter((s) => /closed.*position/i.test(s.name)),
    ...workbook.worksheets.filter((s) => !/closed.*position/i.test(s.name)),
  ];

  for (const sheet of sheets) {
    const headerRowNumber = findHeaderRow(sheet);
    if (headerRowNumber === null) continue;

    const headerCells = cellStrings(sheet.getRow(headerRowNumber));
    const records: Record<string, string>[] = [];
    for (let r = headerRowNumber + 1; r <= sheet.rowCount; r++) {
      const values = cellStrings(sheet.getRow(r));
      if (values.every((v) => v === '')) continue; // blank spacer row — skip, don't stop (XTB's export has some)
      const record: Record<string, string> = {};
      headerCells.forEach((header, i) => {
        if (header) record[header] = values[i] ?? '';
      });
      records.push(record);
    }
    return parseXtbClosedPositionRecords(records, sheet.name);
  }

  return {
    rows: [],
    errors: [{ rowNumber: 0, message: 'No sheet in this workbook contains a recognizable closed-positions header row', raw: {} }],
  };
}

/** True header cells only — ExcelJS gives each column-A-onward cell in order; index 0 in the returned array is column A. */
function cellStrings(row: ExcelJS.Row): string[] {
  const out: string[] = [];
  const max = row.cellCount;
  for (let c = 1; c <= max; c++) {
    out[c - 1] = cellToString(row.getCell(c).value);
  }
  return out;
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && 'richText' in value) {
    return (value.richText as { text: string }[]).map((t) => t.text).join('');
  }
  if (typeof value === 'object' && 'text' in value) return String((value as { text: unknown }).text);
  return String(value);
}

/** First row (scanning from the top) where every REQUIRED_FIELDS canonical column resolves via the same alias map the CSV path uses. */
function findHeaderRow(sheet: ExcelJS.Worksheet): number | null {
  const scanLimit = Math.min(sheet.rowCount, 50); // the real export's header is row 13; 50 is generous headroom
  for (let r = 1; r <= scanLimit; r++) {
    const headers = cellStrings(sheet.getRow(r)).filter((h) => h !== '');
    if (headers.length === 0) continue;
    const columns = resolveColumns(headers);
    if (REQUIRED_FIELDS.every((f) => columns[f])) return r;
  }
  return null;
}

function parseXtbClosedPositionRecords(records: Record<string, string>[], sourceLabel: string): XtbParseResult {
  if (records.length === 0) {
    return { rows: [], errors: [] };
  }

  const columns = resolveColumns(Object.keys(records[0]));
  const missingColumns = REQUIRED_FIELDS.filter((f) => !columns[f]);
  if (missingColumns.length > 0) {
    return {
      rows: [],
      errors: [
        {
          rowNumber: 0,
          message: `${sourceLabel} is missing required column(s): ${missingColumns.join(', ')}. Found headers: ${Object.keys(records[0]).join(', ')}`,
          raw: {},
        },
      ],
    };
  }

  const rows: XtbClosedPositionRow[] = [];
  const errors: XtbParseError[] = [];

  records.forEach((raw, index) => {
    const rowNumber = index + 2; // +1 for header row, +1 for 1-indexing
    const orderId = raw[columns.orderId!]?.trim();
    const symbol = raw[columns.symbol!]?.trim();
    const side = parseSide(raw[columns.side!]);
    const openTime = parseDate(raw[columns.openTime!]);
    const closeTime = parseDate(raw[columns.closeTime!]);

    if (!orderId) {
      errors.push({ rowNumber, message: 'missing order/position id', raw });
      return;
    }
    if (!symbol) {
      errors.push({ rowNumber, message: 'missing symbol', raw });
      return;
    }
    if (!side) {
      errors.push({ rowNumber, message: `unrecognized side "${raw[columns.side!]}"`, raw });
      return;
    }
    if (!openTime) {
      errors.push({ rowNumber, message: `unparseable open time "${raw[columns.openTime!]}"`, raw });
      return;
    }
    if (!closeTime) {
      errors.push({ rowNumber, message: `unparseable close time "${raw[columns.closeTime!]}"`, raw });
      return;
    }

    rows.push({
      orderId,
      symbol,
      side,
      volume: parseNumber(raw[columns.volume!]),
      openTime,
      openPrice: parseNumber(raw[columns.openPrice!]),
      closeTime,
      closePrice: parseNumber(raw[columns.closePrice!]),
      stopLoss: columns.stopLoss ? parseOptionalNumber(raw[columns.stopLoss]) : null,
      takeProfit: columns.takeProfit ? parseOptionalNumber(raw[columns.takeProfit]) : null,
      commission: columns.commission ? parseNumber(raw[columns.commission]) : 0,
      swap: columns.swap ? parseNumber(raw[columns.swap]) : 0,
      profit: parseNumber(raw[columns.profit!]),
      comment: columns.comment ? (raw[columns.comment]?.trim() || null) : null,
      raw,
    });
  });

  return { rows, errors };
}
