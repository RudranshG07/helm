import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { query } from '@mandate/db';

export const SESSION_HEADER = 'x-helm-session';

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

export async function currentSession(merchantId: string): Promise<boolean> {
  const { rows } = await query<{ present: boolean }>(
    `SELECT session_token_hash IS NOT NULL AS present FROM merchant WHERE id = $1`,
    [merchantId],
  );
  return rows[0]?.present === true;
}

function suppliedToken(request: FastifyRequest): string | null {
  const header = request.headers[SESSION_HEADER];
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();

  const q = (request.query as { t?: unknown } | undefined)?.t;
  if (typeof q === 'string' && q.trim().length > 0) return q.trim();

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
    error: 'This dashboard belongs to a merchant account.',
    hint: 'Connect a Razorpay key at /onboard to get your own link. Nobody else can read your mandates.',
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
