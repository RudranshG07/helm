import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt) as (
  password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const PARAMS = { N: 16_384, r: 8, p: 1 };
const KEY_LENGTH = 64;

export const MIN_PASSWORD_LENGTH = 10;

export interface PasswordProblem {
  ok: false;
  problem: string;
}

export function checkPassword(password: string): { ok: true } | PasswordProblem {
  const value = password ?? '';
  if (value.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, problem: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (value.trim().length === 0) {
    return { ok: false, problem: 'A password of only spaces will not protect anything.' };
  }
  return { ok: true };
}

export function checkEmail(email: string): { ok: true } | PasswordProblem {
  const value = (email ?? '').trim();
  if (value.length === 0) return { ok: false, problem: 'Give an email address to sign in with.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return { ok: false, problem: 'That does not look like an email address.' };
  }
  return { ok: true };
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, salt, expected] = parts;
  const key = await derive(password, Buffer.from(salt!, 'base64url'), KEY_LENGTH, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  const want = Buffer.from(expected!, 'base64url');
  if (want.length !== key.length) return false;
  return timingSafeEqual(key, want);
}
