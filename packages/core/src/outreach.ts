import { createHash, randomBytes } from 'node:crypto';
import { fromIst, toIstParts } from './time.ts';

export const OUTREACH_QUIET_START_MINUTE = 21 * 60;
export const OUTREACH_QUIET_END_MINUTE = 9 * 60;
export const OUTREACH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type Channel = 'email' | 'sms' | 'none';

export interface OutreachRequest {
  subscription_id: string;
  cycle: Date;
  decision_id: number | null;
}

export function outreachIdempotencyKey(req: OutreachRequest): string {
  const parts = [
    req.subscription_id,
    req.cycle.toISOString(),
    req.decision_id === null ? 'nodecision' : String(req.decision_id),
  ].join('|');
  return `out_${createHash('sha256').update(parts).digest('hex').slice(0, 32)}`;
}

export function outreachToken(): string {
  return randomBytes(24).toString('base64url');
}

export function isQuietHours(at: Date): boolean {
  const m = toIstParts(at).minuteOfDay;
  return m >= OUTREACH_QUIET_START_MINUTE || m < OUTREACH_QUIET_END_MINUTE;
}

export function nextSendableTime(at: Date): Date {
  if (!isQuietHours(at)) return at;
  const p = toIstParts(at);
  if (p.minuteOfDay < OUTREACH_QUIET_END_MINUTE) {
    return fromIst(p.year, p.month, p.day, OUTREACH_QUIET_END_MINUTE);
  }
  const tomorrow = new Date(at.getTime() + 24 * 60 * 60 * 1000);
  const n = toIstParts(tomorrow);
  return fromIst(n.year, n.month, n.day, OUTREACH_QUIET_END_MINUTE);
}

export function maskRecipient(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.includes('@')) {
    const [user, domain] = trimmed.split('@');
    const head = (user ?? '').slice(0, 2);
    return `${head}${'*'.repeat(Math.max(1, (user ?? '').length - 2))}@${domain ?? ''}`;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 4) return '*'.repeat(trimmed.length);
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

export function pickChannel(
  email: string | null | undefined,
  phone: string | null | undefined,
): Channel {
  if (email && email.includes('@')) return 'email';
  if (phone && phone.replace(/\D/g, '').length >= 10) return 'sms';
  return 'none';
}

export function outreachExpiry(at: Date, cycleEnd: Date | null): Date {
  const ttl = new Date(at.getTime() + OUTREACH_TTL_MS);
  if (cycleEnd && cycleEnd < ttl) return cycleEnd;
  return ttl;
}
