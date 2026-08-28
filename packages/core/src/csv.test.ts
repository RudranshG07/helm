import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from './csv.ts';
import { declineDistribution, importAttempts } from './csv-import.ts';

describe('the parser handles real exported files', () => {
  it('reads a plain file', () => {
    const rows = parseCsv('id,amount\npay_1,49900\npay_2,19900\n');
    expect(rows).toEqual([
      { id: 'pay_1', amount: '49900' },
      { id: 'pay_2', amount: '19900' },
    ]);
  });

  it('handles quoted fields containing commas', () => {
    const rows = parseCsv('id,description\npay_1,"Payment failed, insufficient funds"\n');
    expect(rows[0]!['description']).toBe('Payment failed, insufficient funds');
  });

  it('handles escaped quotes inside a quoted field', () => {
    const rows = parseCsv('id,note\npay_1,"he said ""no"""\n');
    expect(rows[0]!['note']).toBe('he said "no"');
  });

  it('handles a newline inside a quoted field', () => {
    const rows = parseCsv('id,note\npay_1,"line one\nline two"\n');
    expect(rows[0]!['note']).toBe('line one\nline two');
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('id,amount\r\npay_1,100\r\n')).toHaveLength(1);
  });

  it('strips a UTF-8 byte order mark, which Excel adds', () => {
    const rows = parseCsv('﻿id,amount\npay_1,100\n');
    expect(Object.keys(rows[0]!)).toContain('id');
  });

  it('lowercases and trims the header so casing does not matter', () => {
    const rows = parseCsv('  ID , Error Reason \npay_1,insufficient_funds\n');
    expect(rows[0]!['error reason']).toBe('insufficient_funds');
  });

  it('tolerates a file with no trailing newline', () => {
    expect(parseCsv('id,amount\npay_1,100')).toHaveLength(1);
  });

  it('ignores blank lines rather than emitting empty rows', () => {
    expect(parseCsv('id,amount\npay_1,100\n\n')).toHaveLength(1);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('refuses a ragged row rather than silently shifting columns', () => {
    expect(() => parseCsv('id,amount\npay_1,100,extra\n')).toThrow(CsvError);
  });

  it('refuses a duplicated header column', () => {
    expect(() => parseCsv('id,id\na,b\n')).toThrow(/repeats/);
  });

  it('refuses an unterminated quote', () => {
    expect(() => parseCsv('id\n"never closed\n')).toThrow(/Unterminated/);
  });

  it('names the line number in every error', () => {
    try {
      parseCsv('id,amount\npay_1,100\npay_2,100,oops\n');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CsvError).line).toBe(3);
    }
  });
});

const EXPORT = [
  'id,amount,status,created_at,method,error_code,error_description,error_source,error_step,error_reason,bank,invoice_id,customer_id',
  'pay_A,49900,failed,1788220800,upi,BAD_REQUEST_ERROR,"Payment failed, insufficient funds",customer,payment_authentication,insufficient_funds,HDFC,inv_1,cust_1',
  'pay_B,149900,captured,1788307200,upi,,,,,,HDFC,inv_1,cust_1',
  'pay_C,29900,failed,1788393600,card,BAD_REQUEST_ERROR,Card expired,customer,payment_authorization,card_expired,ICICI,inv_2,cust_2',
].join('\n');

describe('the importer maps a Razorpay export', () => {
  const report = importAttempts(parseCsv(EXPORT));

  it('reads every row', () => {
    expect(report.rows_seen).toBe(3);
    expect(report.attempts).toHaveLength(3);
    expect(report.rows_skipped).toBe(0);
  });

  it('keeps the amount as paise integers', () => {
    expect(report.attempts[0]!.amount_paise).toBe(49900);
    expect(Number.isInteger(report.attempts[0]!.amount_paise)).toBe(true);
  });

  it('reads a unix timestamp', () => {
    expect(report.attempts[0]!.attempted_at.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('carries every error field the taxonomy needs', () => {
    expect(report.attempts[0]).toMatchObject({
      error_reason: 'insufficient_funds',
      error_source: 'customer',
      error_step: 'payment_authentication',
      error_code: 'BAD_REQUEST_ERROR',
    });
  });

  it('maps the gateway method name onto ours', () => {
    expect(report.attempts[0]!.method).toBe('upi_autopay');
    expect(report.attempts[2]!.method).toBe('card');
  });

  it('groups attempts under the invoice so a cycle can be reconstructed', () => {
    expect(report.attempts[0]!.subscription_ref).toBe('inv_1');
    expect(report.attempts[1]!.subscription_ref).toBe('inv_1');
  });

  it('reports which header column it used for each field', () => {
    expect(report.resolved_columns.error_reason).toBe('error_reason');
    expect(report.resolved_columns.amount).toBe('amount');
  });

  it('lists columns it did not recognise rather than dropping them silently', () => {
    const withExtra = importAttempts(parseCsv('id,amount,status,created_at,mystery\npay_1,100,failed,1788220800,x\n'));
    expect(withExtra.unrecognised_columns).toContain('mystery');
  });
});

describe('the importer fails loudly rather than guessing', () => {
  it('refuses a file missing required columns and says which', () => {
    const report = importAttempts(parseCsv('id,amount\npay_1,100\n'));
    expect(report.attempts).toHaveLength(0);
    expect(report.problems[0]!.reason).toContain('status');
    expect(report.problems[0]!.reason).toContain('created_at');
  });

  it('skips a row with an unreadable amount and names the line', () => {
    const report = importAttempts(parseCsv(
      'id,amount,status,created_at\npay_1,not-a-number,failed,1788220800\n',
    ));
    expect(report.rows_skipped).toBe(1);
    expect(report.problems[0]!.line).toBe(2);
  });

  it('skips a row with an unreadable date', () => {
    const report = importAttempts(parseCsv(
      'id,amount,status,created_at\npay_1,100,failed,not-a-date\n',
    ));
    expect(report.rows_skipped).toBe(1);
  });

  it('accepts a rupee-formatted amount and converts to paise', () => {
    const report = importAttempts(parseCsv(
      'id,amount,status,created_at\npay_1,"₹1,499.00",failed,1788220800\n',
    ));
    expect(report.attempts[0]!.amount_paise).toBe(149900);
  });

  it('accepts an ISO date as well as a unix timestamp', () => {
    const report = importAttempts(parseCsv(
      'id,amount,status,created_at\npay_1,100,failed,2026-09-01T00:00:00Z\n',
    ));
    expect(report.attempts[0]!.attempted_at.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('maps an unrecognised status to unknown rather than assuming failure', () => {
    const report = importAttempts(parseCsv(
      'id,amount,status,created_at\npay_1,100,something_new,1788220800\n',
    ));
    expect(report.attempts[0]!.status).toBe('unknown');
  });

  it('never throws on an empty file', () => {
    expect(() => importAttempts([])).not.toThrow();
  });
});

describe('the decline distribution is the thing worth sending back', () => {
  const dist = declineDistribution(importAttempts(parseCsv(EXPORT)).attempts);

  it('counts only failures', () => {
    expect(dist).toHaveLength(2);
  });

  it('carries the rupees behind each code, not just the count', () => {
    expect(dist[0]!.amount_paise).toBeGreaterThan(0);
  });

  it('sorts by volume so the biggest problem is first', () => {
    for (let i = 1; i < dist.length; i += 1) {
      expect(dist[i - 1]!.attempts).toBeGreaterThanOrEqual(dist[i]!.attempts);
    }
  });

  it('keeps method separate, because the same code can mean different things', () => {
    expect(new Set(dist.map((d) => d.method)).size).toBe(2);
  });
});
