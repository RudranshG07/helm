import type { Row } from './csv.ts';
import type { Method } from './types.ts';

export interface ColumnMap {
  payment_id: string[];
  amount: string[];
  status: string[];
  created_at: string[];
  method: string[];
  order_id: string[];
  subscription_id: string[];
  customer_id: string[];
  error_code: string[];
  error_description: string[];
  error_source: string[];
  error_step: string[];
  error_reason: string[];
  bank: string[];
}

export const RAZORPAY_COLUMNS: ColumnMap = {
  payment_id: ['id', 'payment_id', 'payment id'],
  amount: ['amount', 'amount (in paise)', 'amount_in_paise'],
  status: ['status', 'payment status'],
  created_at: ['created_at', 'created at', 'date', 'payment date'],
  method: ['method', 'payment method'],
  order_id: ['order_id', 'order id'],
  subscription_id: ['subscription_id', 'subscription id', 'invoice_id', 'invoice id'],
  customer_id: ['customer_id', 'customer id', 'contact', 'email'],
  error_code: ['error_code', 'error code'],
  error_description: ['error_description', 'error description'],
  error_source: ['error_source', 'error source'],
  error_step: ['error_step', 'error step'],
  error_reason: ['error_reason', 'error reason'],
  bank: ['bank', 'issuer', 'bank name'],
};

export const REQUIRED: (keyof ColumnMap)[] = ['payment_id', 'amount', 'status', 'created_at'];

export interface ImportedAttempt {
  payment_id: string;
  order_id: string | null;
  subscription_ref: string;
  customer_ref: string;
  method: Method;
  amount_paise: number;
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'unknown';
  attempted_at: Date;
  error_code: string | null;
  error_description: string | null;
  error_source: string | null;
  error_step: string | null;
  error_reason: string | null;
  bank: string | null;
}

export interface ImportReport {
  attempts: ImportedAttempt[];
  rows_seen: number;
  rows_skipped: number;
  resolved_columns: Partial<Record<keyof ColumnMap, string>>;
  unrecognised_columns: string[];
  problems: { line: number; reason: string }[];
}

function resolve(header: string[], aliases: string[]): string | undefined {
  return aliases.find((a) => header.includes(a));
}

const METHOD_MAP: Record<string, Method> = {
  upi: 'upi_autopay',
  upi_autopay: 'upi_autopay',
  card: 'card',
  emandate: 'emandate',
  nach: 'emandate',
  netbanking: 'emandate',
};

function toMethod(raw: string | undefined): Method {
  const key = raw?.trim().toLowerCase();
  return (key && METHOD_MAP[key]) || 'upi_autopay';
}

function toStatus(raw: string | undefined): ImportedAttempt['status'] {
  const s = raw?.trim().toLowerCase();
  switch (s) {
    case 'created':
    case 'authorized':
    case 'captured':
    case 'failed':
      return s;
    case 'refunded':
      return 'captured';
    default:
      return 'unknown';
  }
}

function toDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d{10}$/.test(trimmed)) return new Date(Number(trimmed) * 1000);
  if (/^\d{13}$/.test(trimmed)) return new Date(Number(trimmed));
  const d = new Date(trimmed);
  return Number.isFinite(d.getTime()) ? d : null;
}

function toPaise(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[₹,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return cleaned.includes('.') ? Math.round(n * 100) : Math.round(n);
}

function nullable(value: string | undefined): string | null {
  const t = value?.trim();
  return t && t.length > 0 ? t : null;
}

export function importAttempts(rows: Row[], columns: ColumnMap = RAZORPAY_COLUMNS): ImportReport {
  const report: ImportReport = {
    attempts: [],
    rows_seen: rows.length,
    rows_skipped: 0,
    resolved_columns: {},
    unrecognised_columns: [],
    problems: [],
  };

  if (rows.length === 0) return report;

  const header = Object.keys(rows[0]!);
  const known = new Set<string>();

  for (const key of Object.keys(columns) as (keyof ColumnMap)[]) {
    const found = resolve(header, columns[key]);
    if (found) {
      report.resolved_columns[key] = found;
      known.add(found);
    }
  }
  report.unrecognised_columns = header.filter((h) => !known.has(h));

  const missing = REQUIRED.filter((k) => !report.resolved_columns[k]);
  if (missing.length > 0) {
    report.problems.push({
      line: 1,
      reason: `Missing required columns: ${missing.join(', ')}. Found header: ${header.join(', ')}`,
    });
    report.rows_skipped = rows.length;
    return report;
  }

  const col = (row: Row, key: keyof ColumnMap): string | undefined => {
    const name = report.resolved_columns[key];
    return name ? row[name] : undefined;
  };

  rows.forEach((row, index) => {
    const line = index + 2;
    const paymentId = nullable(col(row, 'payment_id'));
    const amount = toPaise(col(row, 'amount'));
    const attemptedAt = toDate(col(row, 'created_at'));

    if (!paymentId) {
      report.problems.push({ line, reason: 'No payment id' });
      report.rows_skipped += 1;
      return;
    }
    if (amount === null) {
      report.problems.push({ line, reason: `Unreadable amount "${col(row, 'amount') ?? ''}"` });
      report.rows_skipped += 1;
      return;
    }
    if (!attemptedAt) {
      report.problems.push({ line, reason: `Unreadable date "${col(row, 'created_at') ?? ''}"` });
      report.rows_skipped += 1;
      return;
    }

    const subscriptionRef = nullable(col(row, 'subscription_id')) ?? `csv:${paymentId}`;

    report.attempts.push({
      payment_id: paymentId,
      order_id: nullable(col(row, 'order_id')),
      subscription_ref: subscriptionRef,
      customer_ref: nullable(col(row, 'customer_id')) ?? subscriptionRef,
      method: toMethod(col(row, 'method')),
      amount_paise: amount,
      status: toStatus(col(row, 'status')),
      attempted_at: attemptedAt,
      error_code: nullable(col(row, 'error_code')),
      error_description: nullable(col(row, 'error_description')),
      error_source: nullable(col(row, 'error_source')),
      error_step: nullable(col(row, 'error_step')),
      error_reason: nullable(col(row, 'error_reason')),
      bank: nullable(col(row, 'bank')),
    });
  });

  return report;
}

export interface DeclineCount {
  error_reason: string | null;
  error_source: string | null;
  method: Method;
  attempts: number;
  amount_paise: number;
}

export function declineDistribution(attempts: ImportedAttempt[]): DeclineCount[] {
  const map = new Map<string, DeclineCount>();

  for (const a of attempts) {
    if (a.status !== 'failed') continue;
    const key = `${a.error_reason ?? ''}|${a.error_source ?? ''}|${a.method}`;
    const entry = map.get(key) ?? {
      error_reason: a.error_reason,
      error_source: a.error_source,
      method: a.method,
      attempts: 0,
      amount_paise: 0,
    };
    entry.attempts += 1;
    entry.amount_paise += a.amount_paise;
    map.set(key, entry);
  }

  return [...map.values()].sort((a, b) => b.attempts - a.attempts);
}
