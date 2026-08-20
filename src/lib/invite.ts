import { parse } from "csv-parse/sync";
import { validateEmail } from "../util/validation.js";

export const MAX_INVITE_ROWS = 200;

export interface ParsedInvite {
  name?: string;
  email: string;
}

export interface SkippedInviteRow {
  row: number;
  reason: string;
}

export type ParseInviteCsvResult =
  | {
      ok: true;
      valid: ParsedInvite[];
      skipped: SkippedInviteRow[];
    }
  | {
      ok: false;
      error: string;
    };

export function parseInviteCsv(buffer: Buffer): ParseInviteCsvResult {
  let records: Record<string, string>[];
  try {
    records = parse(buffer.toString("utf8"), {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch {
    return { ok: false, error: "The file could not be parsed as CSV." };
  }

  if (records.length === 0) {
    return { ok: false, error: "The CSV file has no data rows." };
  }

  if (!Object.keys(records[0]).includes("email")) {
    return {
      ok: false,
      error: 'The CSV file must have a header row with an "email" column.',
    };
  }

  if (records.length > MAX_INVITE_ROWS) {
    return {
      ok: false,
      error: `The CSV file has ${records.length} rows, which is more than the ${MAX_INVITE_ROWS}-row limit per upload.`,
    };
  }

  const valid: ParsedInvite[] = [];
  const skipped: SkippedInviteRow[] = [];
  const seenEmails = new Set<string>();

  records.forEach((record, index) => {
    const rowNumber = index + 2; // row 1 is the header
    const rawEmail = (record.email || "").trim();
    const rawName = (record.name || "").trim();

    if (/[\r\n]/.test(rawEmail) || /[\r\n]/.test(rawName)) {
      skipped.push({ row: rowNumber, reason: "invalid characters" });
      return;
    }
    if (!validateEmail(rawEmail)) {
      skipped.push({ row: rowNumber, reason: "invalid email" });
      return;
    }
    const normalizedEmail = rawEmail.toLowerCase();
    if (seenEmails.has(normalizedEmail)) {
      skipped.push({ row: rowNumber, reason: "duplicate email" });
      return;
    }
    seenEmails.add(normalizedEmail);
    valid.push({ email: rawEmail, name: rawName || undefined });
  });

  return { ok: true, valid, skipped };
}
