import { query } from '@mandate/db';

export interface CalibrationBand {
  band: string;
  low: number;
  high: number;
  predicted_mean: number;
  observed_rate: number;
  n: number;
}

export interface Calibration {
  scored: number;
  brier: number | null;
  baseline_brier: number | null;
  skill: number | null;
  observed_rate: number | null;
  predicted_mean: number | null;
  bands: CalibrationBand[];
  real_account_scored: number;
  verdict: string;
}

const BANDS: [number, number][] = [
  [0, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1.0001],
];

interface Row {
  predicted_p: string;
  succeeded: boolean;
  real: boolean;
}

const SCORED = `
  SELECT d.predicted_p::text AS predicted_p,
         (i.state = 'SETTLED_SUCCESS') AS succeeded,
         (m.rzp_key_id IS NOT NULL AND NOT m.synthetic) AS real
    FROM decision d
    JOIN execution_intent i ON i.decision_id = d.id
    JOIN subscription s ON s.id = d.subscription_id
    JOIN merchant m ON m.id = s.merchant_id
   WHERE d.predicted_p IS NOT NULL
     AND i.state IN ('SETTLED_SUCCESS', 'SETTLED_FAILED')
`;

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export async function buildCalibration(): Promise<Calibration> {
  const { rows } = await query<Row>(SCORED);

  const predictions = rows.map((r) => Number(r.predicted_p));
  const outcomes: number[] = rows.map((r) => (r.succeeded ? 1 : 0));
  const scored = rows.length;

  const observed = mean(outcomes);
  const predicted = mean(predictions);

  const brier = scored === 0
    ? null
    : rows.reduce((sum, _r, i) => sum + (predictions[i]! - outcomes[i]!) ** 2, 0) / scored;

  const baseline = scored === 0 || observed === null
    ? null
    : outcomes.reduce((sum: number, o) => sum + (observed - o) ** 2, 0) / scored;

  const skill = brier === null || baseline === null || baseline === 0
    ? null
    : 1 - brier / baseline;

  const bands: CalibrationBand[] = [];
  for (const [low, high] of BANDS) {
    const inBand = rows
      .map((_r, i) => i)
      .filter((i) => predictions[i]! >= low && predictions[i]! < high);
    if (inBand.length === 0) continue;
    bands.push({
      band: `${Math.round(low * 100)}–${Math.round(Math.min(1, high) * 100)}%`,
      low,
      high,
      predicted_mean: mean(inBand.map((i) => predictions[i]!))!,
      observed_rate: mean(inBand.map((i) => outcomes[i]!))!,
      n: inBand.length,
    });
  }

  const real = rows.filter((r) => r.real).length;

  return {
    scored,
    brier,
    baseline_brier: baseline,
    skill,
    observed_rate: observed,
    predicted_mean: predicted,
    bands,
    real_account_scored: real,
    verdict: verdictFor(scored, real, skill),
  };
}

function verdictFor(scored: number, real: number, skill: number | null): string {
  if (scored === 0) {
    return 'No prediction has been scored yet. The model is unmeasured, not merely imprecise.';
  }

  const where = real === 0
    ? `Scored on ${scored} simulated attempts and none on a real account, so this measures the ` +
      'estimator rather than its fit to real customer behaviour'
    : `Scored on ${scored} attempts, ${real} of them on a real account`;

  if (skill === null) {
    return `${where}. Every outcome was the same, so there is nothing for the model to separate.`;
  }
  if (skill > 0) {
    return `${where}. It beats predicting the base rate, with skill ${skill.toFixed(2)}.`;
  }
  return `${where}. It does not beat predicting the base rate, with skill ${skill.toFixed(2)}: ` +
    'the average is close to right, but it is not yet telling a good slot from a bad one.';
}
