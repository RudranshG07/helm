import { query } from '@mandate/db';
import type { Gateway } from './gateway.ts';
import { RefusingGateway } from './gateway.ts';
import { RazorpayGateway } from './razorpay.ts';
import { log } from './log.ts';

async function lookupToken(subscriptionId: string) {
  const { rows } = await query<{ rzp_token_id: string | null; rzp_customer_id: string | null }>(
    `SELECT rzp_token_id, rzp_customer_id FROM subscription WHERE id = $1`,
    [subscriptionId],
  );
  const row = rows[0];
  if (!row?.rzp_token_id || !row.rzp_customer_id) return null;
  return { token_id: row.rzp_token_id, customer_id: row.rzp_customer_id };
}

export function makeGateway(): Gateway {
  const keyId = process.env['RAZORPAY_KEY_ID'];
  const keySecret = process.env['RAZORPAY_KEY_SECRET'];

  if (!keyId || !keySecret) {
    log.warn('gateway.no_credentials', { using: 'refusing' });
    return new RefusingGateway();
  }

  if (process.env['RAZORPAY_MODE'] === 'live' && !keyId.startsWith('rzp_live')) {
    throw new Error('RAZORPAY_MODE is live but the key id is not a live key');
  }
  if (process.env['RAZORPAY_MODE'] !== 'live' && keyId.startsWith('rzp_live')) {
    throw new Error('A live key id was supplied while RAZORPAY_MODE is not live');
  }

  log.info('gateway.ready', { mode: process.env['RAZORPAY_MODE'] ?? 'test', key_id: keyId.slice(0, 12) });
  return new RazorpayGateway({
    credentials: { keyId, keySecret },
    tokenLookup: lookupToken,
  });
}
