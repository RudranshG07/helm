import { decryptSecret, deriveMasterKey } from '@mandate/core';
import { query, withTransaction } from '@mandate/db';
import { RazorpayReader } from './backfill/client.ts';
import { backfill } from './backfill/run.ts';
import { loadCsvText } from './import/csv.ts';
import { log } from './log.ts';

interface Job {
  id: number;
  merchant_id: string;
  kind: 'backfill' | 'csv_import';
  progress: { csv?: string };
}

export async function runOnboardingJobs(days = 180): Promise<number> {
  const claimed = await withTransaction(async (client) => {
    const { rows } = await client.query<Job>(
      `UPDATE onboarding_job SET state = 'running'
        WHERE id = (
          SELECT id FROM onboarding_job
           WHERE state = 'pending'
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING id, merchant_id, kind, progress`,
    );
    return rows[0] ?? null;
  });

  if (!claimed) return 0;

  try {
    if (claimed.kind === 'csv_import') {
      const csv = claimed.progress?.csv;
      if (!csv) throw new Error('The upload carried no file contents.');
      const result = await loadCsvText(csv, claimed.merchant_id);
      await finish(claimed, {
        rows_read: result.report.attempts.length,
        rows_skipped: result.report.rows_skipped,
        attempts_inserted: result.attempts_inserted,
        subscriptions: result.subscriptions_created,
      });
    } else {
      const creds = await credentials(claimed.merchant_id);
      const to = new Date();
      const from = new Date(to.getTime() - days * 86_400_000);
      const reader = new RazorpayReader({ keyId: creds.keyId, keySecret: creds.keySecret });
      const result = await backfill(reader, claimed.merchant_id, from, to);
      await finish(claimed, {
        payments_seen: result.payments_seen,
        attempts_inserted: result.attempts_inserted,
        subscriptions: result.subscriptions_touched,
        requests: result.requests,
      });
    }
    return 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('onboarding.failed', { merchant_id: claimed.merchant_id, kind: claimed.kind, message });
    await query(
      `UPDATE onboarding_job SET state='failed', error=$2, finished_at=clock_timestamp() WHERE id=$1`,
      [claimed.id, message],
    );
    await query(
      `UPDATE merchant SET onboarding_state='failed', onboarding_error=$2 WHERE id=$1`,
      [claimed.merchant_id, message],
    );
    return 1;
  }
}

async function finish(job: Job, progress: Record<string, number>): Promise<void> {
  await query(
    `UPDATE onboarding_job SET state='done', progress=$2::jsonb, finished_at=clock_timestamp() WHERE id=$1`,
    [job.id, JSON.stringify(progress)],
  );
  await query(
    `UPDATE merchant SET onboarding_state='ready', backfilled_at=clock_timestamp() WHERE id=$1`,
    [job.merchant_id],
  );
  log.info('onboarding.ready', { merchant_id: job.merchant_id, ...progress });
}

async function credentials(merchantId: string): Promise<{ keyId: string; keySecret: string }> {
  const secret = process.env['SECRET_MASTER_KEY'];
  if (!secret) throw new Error('SECRET_MASTER_KEY is not configured on the worker.');

  const { rows } = await query<{ rzp_key_id: string | null; rzp_key_secret_enc: Buffer | null }>(
    `SELECT rzp_key_id, rzp_key_secret_enc FROM merchant WHERE id = $1`,
    [merchantId],
  );
  const row = rows[0];
  if (!row?.rzp_key_id || !row.rzp_key_secret_enc) {
    throw new Error('No stored credentials for this merchant.');
  }
  return {
    keyId: row.rzp_key_id,
    keySecret: decryptSecret(row.rzp_key_secret_enc, deriveMasterKey(secret)),
  };
}
