import { TAXONOMY_VERSION, classify, countsAgainstBudget } from '@mandate/core';
import type { Method } from '@mandate/core';
import { query, withTransaction } from '@mandate/db';
import { log } from '../log.ts';

export interface ReclassifyOptions {
  merchantId?: string;
  apply?: boolean;
  allowOpenCycles?: boolean;
  now?: Date;
}

export interface ReclassifyResult {
  taxonomy_version: string;
  applied: boolean;
  scanned: number;
  changed: number;
  unchanged: number;
  budget_freed: number;
  budget_charged: number;
  open_cycle_skipped: number;
  transitions: Record<string, number>;
}

interface Row {
  id: string;
  method: Method;
  bucket: string | null;
  taxonomy_version: string | null;
  counts_against_budget: boolean;
  cycle_open: boolean;
  error_code: string | null;
  error_reason: string | null;
  error_source: string | null;
  error_step: string | null;
}

const SELECT = `
  SELECT pa.id::text AS id,
         s.method,
         pa.bucket,
         pa.taxonomy_version,
         pa.counts_against_budget,
         (s.current_end IS NOT NULL AND s.current_end > $1) AS cycle_open,
         pa.error_code, pa.error_reason, pa.error_source, pa.error_step
    FROM payment_attempt pa
    JOIN subscription s ON s.id = pa.subscription_id
   WHERE pa.status = 'failed'
     AND (pa.taxonomy_version IS DISTINCT FROM $2)
     AND ($3::text IS NULL OR s.merchant_id = $3)
   ORDER BY pa.id`;

export async function reclassify(options: ReclassifyOptions = {}): Promise<ReclassifyResult> {
  const now = options.now ?? new Date();
  const apply = options.apply ?? false;
  const allowOpenCycles = options.allowOpenCycles ?? false;

  const { rows } = await query<Row>(SELECT, [now, TAXONOMY_VERSION, options.merchantId ?? null]);

  const result: ReclassifyResult = {
    taxonomy_version: TAXONOMY_VERSION,
    applied: apply,
    scanned: rows.length,
    changed: 0,
    unchanged: 0,
    budget_freed: 0,
    budget_charged: 0,
    open_cycle_skipped: 0,
    transitions: {},
  };

  const pending: Array<{ row: Row; bucket: string; counts: boolean }> = [];

  for (const row of rows) {
    const next = classify(row, row.method);
    const counts = countsAgainstBudget(row);
    const budgetChanges = counts !== row.counts_against_budget;

    if (budgetChanges && row.cycle_open && !allowOpenCycles) {
      result.open_cycle_skipped += 1;
      log.warn('reclassify.open_cycle_skipped', {
        attempt_id: row.id,
        from_counts_budget: row.counts_against_budget,
        to_counts_budget: counts,
      });
      continue;
    }

    if (next.bucket === row.bucket && !budgetChanges) {
      result.unchanged += 1;
      pending.push({ row, bucket: next.bucket, counts });
      continue;
    }

    result.changed += 1;
    if (budgetChanges) {
      if (counts) result.budget_charged += 1;
      else result.budget_freed += 1;
    }

    const key = `${row.bucket ?? 'NULL'} -> ${next.bucket}`;
    result.transitions[key] = (result.transitions[key] ?? 0) + 1;
    pending.push({ row, bucket: next.bucket, counts });
  }

  if (!apply || pending.length === 0) return result;

  await withTransaction(async (client) => {
    for (const { row, bucket, counts } of pending) {
      if (bucket !== row.bucket || counts !== row.counts_against_budget) {
        await client.query(
          `INSERT INTO taxonomy_reclassification (
             attempt_id, from_bucket, to_bucket, from_version, to_version,
             from_counts_budget, to_counts_budget, cycle_open_at_change
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [row.id, row.bucket, bucket, row.taxonomy_version, TAXONOMY_VERSION,
           row.counts_against_budget, counts, row.cycle_open],
        );
      }

      await client.query(
        `UPDATE payment_attempt
            SET bucket = $2, taxonomy_version = $3, counts_against_budget = $4
          WHERE id = $1`,
        [row.id, bucket, TAXONOMY_VERSION, counts],
      );
    }
  });

  return result;
}
