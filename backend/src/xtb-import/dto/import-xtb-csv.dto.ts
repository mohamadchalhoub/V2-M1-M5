import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

// Accepts CSV/xlsx content as a JSON string field rather than a multipart
// file upload — deliberately, to avoid adding multipart-parsing middleware
// for a single low-traffic endpoint; a client (script, or the future
// dashboard) reads the exported file locally and posts its content. Simpler
// to implement and to test; revisit if a real multipart upload becomes
// worth the dependency.
//
// Historical chart reconstruction phase — XTB/xStation5's real "closed
// positions" export is an .xlsx workbook, not CSV (verified against a real
// export). `xlsxContentBase64` carries that binary content, base64-encoded
// the same way a JSON string field always has to for binary data; exactly
// one of `csvContent`/`xlsxContentBase64` must be present (enforced in
// xtb-import.service.ts, alongside the existing "must not be empty" check —
// same place that already owns content-shape validation for this endpoint).
export class ImportXtbCsvDto {
  @IsUUID() accountId!: string;
  @IsOptional() @IsString() fileName?: string;
  @IsOptional() @IsString() @MinLength(1) csvContent?: string;
  @IsOptional() @IsString() @MinLength(1) xlsxContentBase64?: string;
}
