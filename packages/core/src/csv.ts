export type Row = Record<string, string>;

export class CsvError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'CsvError';
    this.line = line;
  }
}

export function parseCsv(text: string): Row[] {
  const records = parseRecords(text);
  if (records.length === 0) return [];

  const header = records[0]!.map((h) => h.trim().toLowerCase());
  const seen = new Set<string>();
  for (const h of header) {
    if (h.length === 0) throw new CsvError('Header has an empty column name', 1);
    if (seen.has(h)) throw new CsvError(`Header repeats the column "${h}"`, 1);
    seen.add(h);
  }

  const rows: Row[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const cells = records[i]!;
    if (cells.length === 1 && cells[0] === '') continue;
    if (cells.length !== header.length) {
      throw new CsvError(
        `Expected ${header.length} columns, found ${cells.length}`,
        i + 1,
      );
    }
    const row: Row = {};
    header.forEach((name, j) => {
      row[name] = cells[j] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  while (i < src.length) {
    const ch = src[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      record.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (inQuotes) throw new CsvError('Unterminated quoted field', records.length + 1);
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}
