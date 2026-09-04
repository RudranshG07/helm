import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const OPERATOR_HEADER = 'x-helm-operator';

export function operatorPassphrase(): string | null {
  const raw = process.env['OPERATOR_PASSPHRASE']?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function isProtected(): boolean {
  return operatorPassphrase() !== null;
}

function matches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function operatorApproved(request: FastifyRequest): boolean {
  const expected = operatorPassphrase();
  if (expected === null) return true;

  const header = request.headers[OPERATOR_HEADER];
  const supplied = typeof header === 'string' ? header : undefined;
  if (supplied && matches(supplied, expected)) return true;

  const body = request.body as { operator?: unknown } | undefined;
  if (typeof body?.operator === 'string' && matches(body.operator, expected)) return true;

  return false;
}

export async function requireOperator(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (operatorApproved(request)) return true;
  await reply.code(401).send({
    error: 'This action needs the operator passphrase.',
    hint: `Send it as the ${OPERATOR_HEADER} header, or as "operator" in the body.`,
  });
  return false;
}
