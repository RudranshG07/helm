import { readFileSync } from 'node:fs';
import { classify, declineDistribution, importAttempts, isOurBug, parseCsv } from '@mandate/core';
import type { ImportReport, ImportedAttempt } from '@mandate/core';
import { withTransaction } from '@mandate/db';
import { log } from '../log.ts';

export interface LoadResult {
  report: ImportReport;
  subscriptions_created: number;
  attempts_inserted: number;
  attempts_duplicate: number;
}

function cycleOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export async function loadCsv(
  path: string,
  merchantId: string,
  options: { dryRun?: boolean } = {},
): Promise<LoadResult> {
  return loadCsvText(readFileSync(path, 'utf8'), merchantId, options);
}

export async function loadCsvText(
  text: string,
  merchantId: string,
  options: { dryRun?: boolean } = {},
): Promise<LoadResult> {
  const report = importAttempts(parseCsv(text));

  const result: LoadResult = {
    report,
    subscriptions_created: 0,
    attempts_inserted: 0,
    attempts_duplicate: 0,
  };

  if (report.attempts.length === 0 || options.dryRun) return result;

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO merchant (id, name, mode) VALUES ($1, $1, 'test')
       ON CONFLICT (id) DO NOTHING`,
      [merchantId],
    );

    const bySubscription = new Map<string, ImportedAttempt[]>();
    for (const a of report.attempts) {
      const list = bySubscription.get(a.subscription_ref) ?? [];
      list.push(a);
      bySubscription.set(a.subscription_ref, list);
    }

    for (const [ref, attempts] of bySubscription) {
      const id = `${merchantId}:${ref}`;
      const latest = attempts.reduce((a, b) => (a.attempted_at > b.attempted_at ? a : b));
      const amount = Math.max(...attempts.map((a) => a.amount_paise));

      const inserted = await client.query(
        `INSERT INTO subscription (
           id, merchant_id, rzp_subscription_id, customer_ref, method,
           amount_paise, status, current_start
         ) VALUES ($1,$2,$3,$4,$5,GREATEST($6,1),'unknown',$7)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [id, merchantId, ref, latest.customer_ref, latest.method, amount, cycleOf(latest.attempted_at)],
      );
      result.subscriptions_created += inserted.rowCount ?? 0;

      for (const a of attempts) {
        const classification = classify(a, a.method);
        const rows = await client.query(
          `INSERT INTO payment_attempt (
             subscription_id, rzp_payment_id, rzp_order_id, cycle, attempted_at, status,
             amount_paise, error_code, error_description, error_source, error_step, error_reason,
             issuer, bank, initiated_by, source, bucket, taxonomy_version, counts_against_budget
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,'razorpay_default','csv_import',$14,$15,FALSE)
           ON CONFLICT (rzp_payment_id) WHERE rzp_payment_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [
            id, a.payment_id, a.order_id, cycleOf(a.attempted_at), a.attempted_at, a.status,
            a.amount_paise, a.error_code, a.error_description, a.error_source, a.error_step,
            a.error_reason, a.bank, classification.bucket, classification.taxonomy_version,
          ],
        );
        if ((rows.rowCount ?? 0) > 0) result.attempts_inserted += 1;
        else result.attempts_duplicate += 1;

        if (isOurBug(a)) {
          log.warn('csv.malformed_request_row', { payment_id: a.payment_id });
        }
      }
    }
  });

  return result;
}

export function renderImport(result: LoadResult, path: string, merchantId: string): string {
  const { report } = result;
  const dist = declineDistribution(report.attempts);
  const rupees = (p: number) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`;

  const failures = report.attempts.filter((a) => a.status === 'failed');
  const atRisk = failures.reduce((s, a) => s + a.amount_paise, 0);

  const lines = [
    `# Failed payment analysis`,
    '',
    `Source: \`${path}\` · Merchant: \`${merchantId}\``,
    '',
    '| | |',
    '|---|---|',
    `| Rows in file | ${report.rows_seen} |`,
    `| Rows read | ${report.attempts.length} |`,
    `| Rows skipped | ${report.rows_skipped} |`,
    `| Failed payments | ${failures.length} |`,
    `| Amount behind those failures | ${rupees(atRisk)} |`,
    '',
  ];

  if (report.problems.length > 0) {
    lines.push('## Rows we could not read', '', '| line | reason |', '|---|---|');
    for (const p of report.problems.slice(0, 20)) lines.push(`| ${p.line} | ${p.reason} |`);
    if (report.problems.length > 20) lines.push(`| … | ${report.problems.length - 20} more |`);
    lines.push('');
  }

  if (report.unrecognised_columns.length > 0) {
    lines.push(
      '## Columns we did not use',
      '',
      report.unrecognised_columns.map((c) => `\`${c}\``).join(', '),
      '',
    );
  }

  lines.push('## Why the payments failed', '');
  if (dist.length === 0) {
    lines.push('No failed payments in this export.', '');
  } else {
    lines.push('| reason | source | method | attempts | amount | bucket |', '|---|---|---|---|---|---|');
    for (const d of dist) {
      const bucket = classify(
        { error_reason: d.error_reason, error_source: d.error_source },
        d.method,
      );
      lines.push(
        `| \`${d.error_reason ?? 'none recorded'}\` | ${d.error_source ?? '—'} | ${d.method} | ` +
          `${d.attempts} | ${rupees(d.amount_paise)} | ${bucket.bucket} |`,
      );
    }
    lines.push('');

    const hard = dist.filter((d) =>
      classify({ error_reason: d.error_reason, error_source: d.error_source }, d.method)
        .bucket.startsWith('HARD'),
    );
    const hardAttempts = hard.reduce((s, d) => s + d.attempts, 0);
    const hardAmount = hard.reduce((s, d) => s + d.amount_paise, 0);

    if (hardAttempts > 0) {
      lines.push(
        `**${hardAttempts} of these ${failures.length} failures could not have succeeded on a retry** ` +
          `— a dead instrument or a customer who cancelled — covering ${rupees(hardAmount)}. ` +
          'The default schedule spends its full retry budget on those exactly as it does on a ' +
          'customer who was briefly short of funds.',
        '',
      );
    }

    const unknown = dist.filter((d) =>
      classify({ error_reason: d.error_reason, error_source: d.error_source }, d.method)
        .bucket === 'UNKNOWN',
    );
    if (unknown.length > 0) {
      lines.push(
        `${unknown.length} decline ${unknown.length === 1 ? 'code is' : 'codes are'} not yet in ` +
          'our taxonomy. Those are listed rather than guessed at, and they get one conservative ' +
          'attempt rather than the full budget.',
        '',
      );
    }
  }

  return lines.join('\n');
}
