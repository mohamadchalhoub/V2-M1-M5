# XTB CSV importer — Phase 8
> See `../../../PROJECT_STATUS.md` at the repo root for the authoritative build order, phase-numbering crosswalk, and current status of every component.

Status: **Implemented and tested**, built autonomously while you were away — please review, especially
§4's flagged assumption. Unlike Phases 4–7, this one has a genuine open risk: the CSV column format
is my best guess at XTB's export, not verified against a real file (see §4).

## 1. What this is

MT5 accounts get trading data live, via the collector. XTB accounts don't have an equivalent
API integration yet (Phase 0 §12), so this fills that gap with a manual path: a trader exports
their "closed positions" statement from XTB/xStation5 as CSV and posts it to this endpoint. The
importer normalizes it into the same `trades` table MT5 data lands in, so analytics, rules, and
alerts all work identically regardless of which platform an account is on — nothing downstream
of `trades` knows or cares that a row came from a file instead of a live feed.

## 2. Architecture

```
XtbImportController  POST /xtb-import { accountId, fileName?, csvContent }
                      GET  /xtb-import/batches/:accountId
  → XtbImportService.importCsv()
      1. verify the account is platform=XTB (never writes to an MT5 account)
      2. SHA256 the whole file → import_batches (accountId, fileSha256) — whole-file dedup
      3. parseXtbClosedPositionsCsv()  — the ONE file that knows XTB's column names
      4. per row: skip if externalTradeId already exists (row-level dedup, reuses Trade's own
         unique constraint — Phase 0 §06: no ingestion path gets a second, bespoke dedup mechanism)
      5. write TWO Trade rows per closed-position row (IN + IN's synthetic open leg, OUT carrying
         the realized P/L) — matches the shape MT5 deals already have, so analytics functions that
         read "opening size from IN deals" work unmodified for XTB too
      6. update import_batches with final counts/status
```

`ImportBatch` is resumable by design: a `PENDING` or `FAILED` row for the same file hash is
re-processed, not treated as done — only `COMPLETED` short-circuits. Because row-level dedup
happens independently, re-uploading the same file after a crash or a partial failure is the
correct "resume" action; there's no separate resume endpoint or flag.

`checkXtbImport()` (`health-checks.ts`) now reads the real table: no batch ever run is `OK`
("nothing to report" isn't a failure), the most recent batch having `FAILED` is `DOWN`, anything
else is `OK` — event-driven off the importer's own outcome, not a poll of ongoing state, per
Phase 0 §13 ("the importer itself flags a failed import_batches row directly").

## 3. CSV format

The parser (`xtb-csv-parser.ts`) accepts a broad set of header spellings per canonical field
(`COLUMN_ALIASES`) — case/whitespace-insensitive — rather than one fixed header row, since export
formats vary by platform version and locale. Required columns: order/position id, symbol,
side, volume, open time, open price, close time, close price, profit. Optional: stop loss, take
profit, commission, swap, comment (default to `null`/`0` when absent). Numeric fields tolerate
thousands separators. A row that fails to parse is collected as a per-row error and skipped;
valid rows in the same file still import. A file with zero valid rows marks the batch `FAILED`.

## 4. Assumption made without asking (flag this on review)

**The column names in `COLUMN_ALIASES` are not verified against a real XTB export file.** They're
based on commonly-documented xStation5 "closed positions" statement fields, but I have no actual
export to check them against. This is the one piece of Phase 8 that genuinely needs you: export a
real closed-positions CSV from your XTB account, and either (a) it imports cleanly and this is
done, or (b) some columns aren't recognized and `xtb-csv-parser.ts`'s `COLUMN_ALIASES` is the
single place to fix — nothing else in the module changes. `POST /xtb-import` returns per-row
parse errors in `error`, so a failed real-file attempt will say exactly which columns it couldn't
resolve.

Also carried over from Phase 7's posture, not re-litigated here: no auth on either endpoint yet
(same as `/health` — revisit once the dashboard has a real login flow); `csvContent` is accepted
as a JSON string field rather than a multipart upload, to avoid adding multipart middleware for
one low-traffic endpoint.

## 5. Data model

```
import_batches: id, account_id, file_sha256, file_name?, status (PENDING/COMPLETED/FAILED),
                rows_total, rows_imported, rows_skipped, error?, created_at, completed_at?
  @@unique([account_id, file_sha256])
```

`Trade.externalTradeId` for the two synthetic legs is `${orderId}-IN` / `${orderId}-OUT`;
`Trade.rawPayload` preserves the exact original CSV cell values for that row, verbatim, on both
legs (Phase 0 §04/§12, Req. 10).
