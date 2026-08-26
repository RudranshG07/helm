export interface AttemptIdentity {
  subscription_id: string;
  cycle: Date;
  attempt_number: number;
}

const MAX_RECEIPT_LENGTH = 40;

export function idempotencyKey(identity: AttemptIdentity): string {
  const { subscription_id, cycle, attempt_number } = identity;

  if (!subscription_id) throw new Error('idempotencyKey requires a subscription_id');
  if (!Number.isInteger(attempt_number) || attempt_number < 1) {
    throw new Error('idempotencyKey requires an integer attempt_number of at least 1');
  }
  const cycleMs = cycle?.getTime();
  if (cycleMs === undefined || !Number.isFinite(cycleMs)) {
    throw new Error('idempotencyKey requires a valid cycle date');
  }

  const cycleEpoch = Math.floor(cycleMs / 1000);
  return `mr_${subscription_id}_${cycleEpoch}_${attempt_number}`;
}

export function orderReceipt(identity: AttemptIdentity): string {
  const key = idempotencyKey(identity);
  if (key.length <= MAX_RECEIPT_LENGTH) return key;

  const { cycle, attempt_number } = identity;
  const suffix = `_${Math.floor(cycle.getTime() / 1000)}_${attempt_number}`;
  const room = MAX_RECEIPT_LENGTH - suffix.length - 3;
  return `mr_${stableDigest(identity.subscription_id, room)}${suffix}`;
}

function stableDigest(value: string, length: number): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, Math.max(1, length));
}

export function parseIdempotencyKey(key: string): AttemptIdentity | null {
  const match = /^mr_(.+)_(\d+)_(\d+)$/.exec(key);
  if (!match) return null;
  return {
    subscription_id: match[1]!,
    cycle: new Date(Number(match[2]) * 1000),
    attempt_number: Number(match[3]),
  };
}
