export type LiquidityTier = 'own_history' | 'merchant_default' | 'population_default';

export interface LiquidityWindow {
  preferred_day: number | null;
  window_days: [number, number] | null;
  confidence: number;
  tier: LiquidityTier;
  sample_size: number;
}

const CYCLE = 31;
const POPULATION_DEFAULT: [number, number] = [1, 5];

function toAngle(day: number): number {
  return (2 * Math.PI * (day - 1)) / CYCLE;
}

function fromAngle(angle: number): number {
  const normalized = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.round((normalized * CYCLE) / (2 * Math.PI)) + 1;
}

export function circularMean(days: number[]): { day: number; concentration: number } | null {
  const valid = days.filter((d) => Number.isFinite(d) && d >= 1 && d <= 31);
  if (valid.length === 0) return null;

  let x = 0;
  let y = 0;
  for (const day of valid) {
    x += Math.cos(toAngle(day));
    y += Math.sin(toAngle(day));
  }
  x /= valid.length;
  y /= valid.length;

  const concentration = Math.sqrt(x * x + y * y);
  if (concentration < 1e-9) return null;

  let day = fromAngle(Math.atan2(y, x));
  if (day > CYCLE) day -= CYCLE;
  if (day < 1) day += CYCLE;

  return { day, concentration };
}

function widen(day: number, halfWidth: number): [number, number] {
  const lo = day - halfWidth;
  const hi = day + halfWidth;
  const wrap = (d: number) => ((((d - 1) % CYCLE) + CYCLE) % CYCLE) + 1;
  return [wrap(lo), wrap(hi)];
}

export function inferLiquidityWindow(
  ownSuccessDays: number[],
  merchantDefaultDays: number[] = [],
): LiquidityWindow {
  const own = ownSuccessDays.filter((d) => Number.isFinite(d) && d >= 1 && d <= 31);

  if (own.length >= 3) {
    const stat = circularMean(own);
    if (stat) {
      const strong = own.length >= 6;
      const halfWidth = strong ? Math.max(1, Math.round((1 - stat.concentration) * 6)) : 3;
      return {
        preferred_day: stat.day,
        window_days: widen(stat.day, halfWidth),
        confidence: Math.round(Math.min(strong ? 0.85 : 0.55, stat.concentration) * 100) / 100,
        tier: 'own_history',
        sample_size: own.length,
      };
    }
  }

  const merchant = merchantDefaultDays.filter((d) => Number.isFinite(d) && d >= 1 && d <= 31);
  if (merchant.length >= 5) {
    const stat = circularMean(merchant);
    if (stat) {
      return {
        preferred_day: stat.day,
        window_days: widen(stat.day, 4),
        confidence: 0.3,
        tier: 'merchant_default',
        sample_size: merchant.length,
      };
    }
  }

  return {
    preferred_day: POPULATION_DEFAULT[0],
    window_days: POPULATION_DEFAULT,
    confidence: 0.15,
    tier: 'population_default',
    sample_size: own.length,
  };
}

export function clampToMonth(day: number, year: number, monthIndex: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Math.min(day, lastDay);
}
