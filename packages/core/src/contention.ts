export interface AttemptObservation {
  day_of_month: number;
  hour: number;
  amount_paise: number;
  succeeded: boolean;
}

export interface Cell {
  day_band: DayBand;
  hour_band: HourBand;
  attempts: number;
  successes: number;
}

export type DayBand = 'payday' | 'early' | 'mid' | 'late';
export type HourBand = 'night' | 'morning' | 'midday' | 'afternoon' | 'evening';

export const PAYDAY_DAYS = [1, 2, 3];

export function dayBand(dayOfMonth: number): DayBand {
  if (PAYDAY_DAYS.includes(dayOfMonth)) return 'payday';
  if (dayOfMonth <= 7) return 'early';
  if (dayOfMonth <= 20) return 'mid';
  return 'late';
}

export function hourBand(hour: number): HourBand {
  if (hour < 6) return 'night';
  if (hour < 10) return 'morning';
  if (hour < 13) return 'midday';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

export interface AmountSplit {
  small: { attempts: number; successes: number };
  large: { attempts: number; successes: number };
  threshold_paise: number;
}

export function medianAmount(observations: AttemptObservation[]): number {
  if (observations.length === 0) return 0;
  const sorted = observations.map((o) => o.amount_paise).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

export function splitByAmount(
  observations: AttemptObservation[],
  threshold: number,
): AmountSplit {
  const split: AmountSplit = {
    small: { attempts: 0, successes: 0 },
    large: { attempts: 0, successes: 0 },
    threshold_paise: threshold,
  };
  for (const o of observations) {
    const side = o.amount_paise > threshold ? split.large : split.small;
    side.attempts += 1;
    if (o.succeeded) side.successes += 1;
  }
  return split;
}

export interface AmountEffect {
  small_success_rate: number | null;
  large_success_rate: number | null;
  gap: number | null;
  small_n: number;
  large_n: number;
}

function rate(part: { attempts: number; successes: number }): number | null {
  return part.attempts > 0 ? part.successes / part.attempts : null;
}

export function amountEffect(split: AmountSplit): AmountEffect {
  const small = rate(split.small);
  const large = rate(split.large);
  return {
    small_success_rate: small,
    large_success_rate: large,
    gap: small !== null && large !== null ? small - large : null,
    small_n: split.small.attempts,
    large_n: split.large.attempts,
  };
}

export type ContentionVerdict =
  | 'contention'
  | 'funding'
  | 'inconclusive_low_volume'
  | 'inconclusive_no_difference';

export interface ContentionTest {
  verdict: ContentionVerdict;
  contested: AmountEffect;
  uncontested: AmountEffect;
  differential: number | null;
  z: number | null;
  threshold_paise: number;
  explanation: string;
}

export const MIN_CELL_ATTEMPTS = 30;
export const Z_THRESHOLD = 1.96;

function seDiff(a: AmountEffect): number | null {
  if (a.small_success_rate === null || a.large_success_rate === null) return null;
  if (a.small_n === 0 || a.large_n === 0) return null;
  const ps = a.small_success_rate;
  const pl = a.large_success_rate;
  const v = (ps * (1 - ps)) / a.small_n + (pl * (1 - pl)) / a.large_n;
  return v > 0 ? Math.sqrt(v) : null;
}

export function testContention(
  contestedWindow: AttemptObservation[],
  uncontestedWindow: AttemptObservation[],
): ContentionTest {
  const all = [...contestedWindow, ...uncontestedWindow];
  const threshold = medianAmount(all);

  const contested = amountEffect(splitByAmount(contestedWindow, threshold));
  const uncontested = amountEffect(splitByAmount(uncontestedWindow, threshold));

  const base = { contested, uncontested, threshold_paise: threshold };

  const enoughVolume =
    contested.small_n >= MIN_CELL_ATTEMPTS &&
    contested.large_n >= MIN_CELL_ATTEMPTS &&
    uncontested.small_n >= MIN_CELL_ATTEMPTS &&
    uncontested.large_n >= MIN_CELL_ATTEMPTS;

  if (!enoughVolume) {
    return {
      ...base,
      verdict: 'inconclusive_low_volume',
      differential: null,
      z: null,
      explanation:
        `Each amount band in each window needs at least ${MIN_CELL_ATTEMPTS} attempts. ` +
        `Observed contested ${contested.small_n}/${contested.large_n}, ` +
        `uncontested ${uncontested.small_n}/${uncontested.large_n}.`,
    };
  }

  const differential = (contested.gap ?? 0) - (uncontested.gap ?? 0);

  const seContested = seDiff(contested);
  const seUncontested = seDiff(uncontested);
  if (seContested === null || seUncontested === null) {
    return {
      ...base,
      verdict: 'inconclusive_low_volume',
      differential,
      z: null,
      explanation: 'Success rates were degenerate in at least one band.',
    };
  }

  const se = Math.sqrt(seContested ** 2 + seUncontested ** 2);
  const z = se > 0 ? differential / se : 0;

  if (z >= Z_THRESHOLD) {
    return {
      ...base,
      verdict: 'contention',
      differential: round(differential),
      z: round(z),
      explanation:
        'Large debits fail disproportionately in the contested window. ' +
        'That is the signature of a queueing collision, not an empty account: ' +
        'clearing a larger debit needs more residual balance after earlier debits have taken their cut.',
    };
  }

  if (z <= -Z_THRESHOLD) {
    return {
      ...base,
      verdict: 'funding',
      differential: round(differential),
      z: round(z),
      explanation:
        'Large debits do not fail disproportionately in the contested window. ' +
        'The amount effect points the other way, which is consistent with a funding shortfall rather than contention.',
    };
  }

  return {
    ...base,
    verdict: 'inconclusive_no_difference',
    differential: round(differential),
    z: round(z),
    explanation:
      'The amount effect is not materially different between contested and uncontested windows. ' +
      'On this data the contention hypothesis is not supported and not refuted.',
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
