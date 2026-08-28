import type { Bucket, Method } from './types.ts';
import { dayBand, hourBand } from './contention.ts';
import type { DayBand, HourBand } from './contention.ts';

export interface Outcome {
  bucket: Bucket;
  issuer: string | null;
  method: Method;
  day_of_month: number;
  hour: number;
  days_since_failure: number;
  amount_paise: number;
  succeeded: boolean;
}

export interface Slot {
  bucket: Bucket;
  issuer: string | null;
  method: Method;
  day_of_month: number;
  hour: number;
  days_since_failure: number;
  amount_paise: number;
}

export type LagBand = 'same_day' | 'next_day' | 'few_days' | 'week_plus';

export function lagBand(days: number): LagBand {
  if (days < 1) return 'same_day';
  if (days < 2) return 'next_day';
  if (days < 7) return 'few_days';
  return 'week_plus';
}

interface Counts {
  attempts: number;
  successes: number;
}

const EMPTY: Counts = { attempts: 0, successes: 0 };

function add(a: Counts, succeeded: boolean): Counts {
  return { attempts: a.attempts + 1, successes: a.successes + (succeeded ? 1 : 0) };
}

function cellKey(s: Slot | Outcome): string {
  return [s.bucket, s.method, s.issuer ?? '_', dayBand(s.day_of_month), hourBand(s.hour), lagBand(s.days_since_failure)].join('|');
}

function bucketKey(s: Slot | Outcome): string {
  return [s.bucket, s.method, dayBand(s.day_of_month), hourBand(s.hour)].join('|');
}

function coarseKey(s: Slot | Outcome): string {
  return [s.bucket, s.method].join('|');
}

export interface Prediction {
  p: number;
  low: number;
  high: number;
  evidence: number;
  level: 'cell' | 'bucket' | 'coarse' | 'prior';
}

export const PRIOR_STRENGTH = 8;
export const SHRINK_STRENGTH = 12;

export class SuccessModel {
  private readonly cells = new Map<string, Counts>();
  private readonly buckets = new Map<string, Counts>();
  private readonly coarse = new Map<string, Counts>();
  private global: Counts = EMPTY;

  constructor(outcomes: Outcome[] = []) {
    for (const o of outcomes) this.observe(o);
  }

  observe(o: Outcome): void {
    this.cells.set(cellKey(o), add(this.cells.get(cellKey(o)) ?? EMPTY, o.succeeded));
    this.buckets.set(bucketKey(o), add(this.buckets.get(bucketKey(o)) ?? EMPTY, o.succeeded));
    this.coarse.set(coarseKey(o), add(this.coarse.get(coarseKey(o)) ?? EMPTY, o.succeeded));
    this.global = add(this.global, o.succeeded);
  }

  private globalRate(): number {
    return this.global.attempts > 0 ? this.global.successes / this.global.attempts : 0.5;
  }

  predict(slot: Slot): Prediction {
    const globalRate = this.globalRate();

    const coarse = this.coarse.get(coarseKey(slot)) ?? EMPTY;
    const coarseMean = shrink(coarse, globalRate, PRIOR_STRENGTH);

    const bucket = this.buckets.get(bucketKey(slot)) ?? EMPTY;
    const bucketMean = shrink(bucket, coarseMean, SHRINK_STRENGTH);

    const cell = this.cells.get(cellKey(slot)) ?? EMPTY;
    const cellMean = shrink(cell, bucketMean, SHRINK_STRENGTH);

    const evidence = cell.attempts;
    const level: Prediction['level'] =
      cell.attempts > 0 ? 'cell'
      : bucket.attempts > 0 ? 'bucket'
      : coarse.attempts > 0 ? 'coarse'
      : 'prior';

    const alpha = cell.successes + bucketMean * SHRINK_STRENGTH;
    const beta = cell.attempts - cell.successes + (1 - bucketMean) * SHRINK_STRENGTH;
    const sd = Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));

    return {
      p: clamp(cellMean),
      low: clamp(cellMean - 1.96 * sd),
      high: clamp(cellMean + 1.96 * sd),
      evidence,
      level,
    };
  }

  get size(): number {
    return this.global.attempts;
  }
}

function shrink(counts: Counts, parentMean: number, strength: number): number {
  const alpha = counts.successes + parentMean * strength;
  const beta = counts.attempts - counts.successes + (1 - parentMean) * strength;
  const total = alpha + beta;
  return total > 0 ? alpha / total : parentMean;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, Math.round(n * 10000) / 10000));
}
