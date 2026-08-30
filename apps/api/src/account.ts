import { query } from '@mandate/db';

export type RailStatus = 'usable' | 'disabled' | 'not_provisioned' | 'failing';

export interface Rail {
  rail: string;
  label: string;
  status: RailStatus;
  detail: string;
  observed_failures: number;
}

export interface AccountCapability {
  probed: boolean;
  activated: boolean;
  rails: Rail[];
  usable: string[];
  verdict: 'live_ready' | 'blocked';
  summary: string;
}

interface MethodsResponse {
  card?: unknown;
  upi?: unknown;
  netbanking?: unknown;
  emandate?: unknown;
  nach?: unknown;
  recurring?: Record<string, unknown>;
}

interface PreferencesResponse {
  activated?: boolean;
}

const FAILURE_SQL = `
  SELECT s.method, count(*)::int AS n
    FROM payment_attempt pa
    JOIN subscription s ON s.id = pa.subscription_id
   WHERE pa.status = 'failed'
     AND pa.error_source = 'internal'
     AND pa.attempted_at > now() - interval '7 days'
   GROUP BY s.method`;

function enabled(value: unknown): boolean {
  if (value === true) return true;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

export async function probeAccount(keyId: string | undefined): Promise<AccountCapability> {
  if (!keyId) {
    return {
      probed: false, activated: false, rails: [], usable: [],
      verdict: 'blocked', summary: 'No Razorpay key is configured.',
    };
  }

  const base = 'https://api.razorpay.com/v1';
  const [methods, prefs] = await Promise.all([
    fetchJson<MethodsResponse>(`${base}/methods?key_id=${encodeURIComponent(keyId)}`),
    fetchJson<PreferencesResponse>(`${base}/preferences?key_id=${encodeURIComponent(keyId)}`),
  ]);

  if (!methods) {
    return {
      probed: false, activated: false, rails: [], usable: [],
      verdict: 'blocked', summary: 'Razorpay did not answer the capability probe.',
    };
  }

  const failures = new Map<string, number>();
  try {
    const { rows } = await query<{ method: string; n: number }>(FAILURE_SQL);
    for (const row of rows) failures.set(row.method, row.n);
  } catch { /* capability is still reportable without observed history */ }

  const activated = prefs?.activated === true;
  const recurring = methods.recurring ?? {};

  const rails: Rail[] = [];

  const cardFailures = failures.get('card') ?? 0;
  rails.push({
    rail: 'card',
    label: 'Recurring card',
    status: !enabled(methods.card)
      ? 'disabled'
      : cardFailures > 0
        ? 'failing'
        : !enabled(recurring['card'])
          ? 'not_provisioned'
          : activated ? 'usable' : 'failing',
    detail: !enabled(methods.card)
      ? 'Cards are switched off for this account.'
      : cardFailures > 0
        ? `${cardFailures} mandate registrations failed inside Razorpay in the last 7 days.`
        : !enabled(recurring['card'])
          ? 'Cards work, but recurring is not provisioned.'
          : activated
            ? 'Advertised by the account.'
            : 'Provisioned, but the account is not activated.',
    observed_failures: cardFailures,
  });

  rails.push({
    rail: 'upi_autopay',
    label: 'UPI Autopay',
    status: !enabled(methods.upi)
      ? 'disabled'
      : !enabled(recurring['upi'])
        ? 'not_provisioned'
        : activated ? 'usable' : 'failing',
    detail: !enabled(methods.upi)
      ? 'UPI is switched off for this account.'
      : !enabled(recurring['upi'])
        ? 'UPI is on, but Autopay is not provisioned.'
        : activated
          ? 'Available.'
          : 'Provisioned, but the account is not activated.',
    observed_failures: failures.get('upi_autopay') ?? 0,
  });

  const emandateBanks = enabled(recurring['emandate'])
    ? Object.keys(recurring['emandate'] as Record<string, unknown>).length
    : 0;
  rails.push({
    rail: 'emandate',
    label: 'eMandate',
    status: emandateBanks === 0 ? 'not_provisioned' : activated ? 'usable' : 'failing',
    detail: emandateBanks === 0
      ? 'No eMandate banks are provisioned.'
      : activated
        ? `${emandateBanks} banks provisioned.`
        : `${emandateBanks} banks provisioned, but the account is not activated, so authorisation is refused.`,
    observed_failures: failures.get('emandate') ?? 0,
  });

  rails.push({
    rail: 'nach',
    label: 'NACH',
    status: enabled(recurring['nach']) ? (activated ? 'usable' : 'failing') : 'not_provisioned',
    detail: enabled(recurring['nach'])
      ? (activated ? 'Available.' : 'Provisioned, but the account is not activated.')
      : 'Not provisioned.',
    observed_failures: failures.get('nach') ?? 0,
  });

  const usable = rails.filter((r) => r.status === 'usable').map((r) => r.rail);

  return {
    probed: true,
    activated,
    rails,
    usable,
    verdict: usable.length > 0 ? 'live_ready' : 'blocked',
    summary: usable.length > 0
      ? `${usable.length} recurring rail${usable.length === 1 ? '' : 's'} can take a live mandate.`
      : activated
        ? 'No recurring rail on this account can take a mandate right now.'
        : 'This account has not completed activation, so no recurring rail will accept a mandate.',
  };
}
