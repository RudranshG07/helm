import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { query } from '@mandate/db';

export const SESSION_HEADER = 'x-helm-session';
export const SESSION_COOKIE = 'helm_session';
const SESSION_DAYS = 30;

export function mintSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueSession(merchantId: string): Promise<string> {
  const token = mintSessionToken();
  await query(
    `UPDATE merchant
        SET session_token_hash = $2, session_issued_at = now()
      WHERE id = $1`,
    [merchantId, hashSessionToken(token)],
  );
  return token;
}

function overHttps(request: FastifyRequest): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]!.trim() === 'https';
  return request.protocol === 'https';
}

export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
): void {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ];
  if (overHttps(request)) parts.push('Secure');
  void reply.header('set-cookie', parts.join('; '));
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (overHttps(request)) parts.push('Secure');
  void reply.header('set-cookie', parts.join('; '));
}

export async function signIn(
  request: FastifyRequest,
  reply: FastifyReply,
  merchantId: string,
): Promise<void> {
  setSessionCookie(request, reply, await issueSession(merchantId));
}

function cookieToken(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return null;

  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(index + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}

function suppliedToken(request: FastifyRequest): string | null {
  const fromCookie = cookieToken(request);
  if (fromCookie !== null) return fromCookie;

  const header = request.headers[SESSION_HEADER];
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();

  return null;
}

export async function resolveMerchant(request: FastifyRequest): Promise<string | null> {
  const token = suppliedToken(request);
  if (token === null) return null;

  const { rows } = await query<{ id: string }>(
    `SELECT id FROM merchant WHERE session_token_hash = $1`,
    [hashSessionToken(token)],
  );
  return rows[0]?.id ?? null;
}

export async function requireMerchant(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const merchant = await resolveMerchant(request);
  if (merchant !== null) return merchant;

  await reply.code(401).send({
    error: 'Sign in to see this.',
    hint: 'This dashboard answers for one business, and only to the person signed in to it.',
  });
  return null;
}

export async function requireOwnMerchant(
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
): Promise<boolean> {
  const caller = await requireMerchant(request, reply);
  if (caller === null) return false;
  if (caller !== id) {
    await reply.code(403).send({ error: 'That is not your merchant account.' });
    return false;
  }
  return true;
}
