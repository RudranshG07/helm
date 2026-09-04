import {
  buildMessage,
  maskRecipient,
  nextSendableTime,
  outreachExpiry,
  outreachIdempotencyKey,
  outreachToken,
  pickChannel,
  resolveLanguage,
} from '@mandate/core';
import { query, withTransaction } from '@mandate/db';
import type { PoolClient } from 'pg';
import { config } from '../config.ts';
import { log } from '../log.ts';
import type { OutreachProvider } from './provider.ts';

export interface OutreachRequest {
  decision_id: number | null;
  subscription_id: string;
  cycle: Date;
  now?: Date;
}

export type OutreachResult =
  | { status: 'sent'; key: string; token: string; channel: string; provider_ref: string }
  | { status: 'queued'; key: string; token: string; channel: string; reason: string }
  | { status: 'duplicate'; key: string }
  | { status: 'deferred'; key: string; until: Date }
  | { status: 'blocked'; key: string; reason: string };

interface Target {
  contact_email: string | null;
  contact_phone: string | null;
  outreach_opted_out: boolean;
  customer_ref: string;
  amount_paise: string;
  current_end: Date | null;
  contact_language: string;
  merchant_name: string;
  kill_switch: boolean;
  write_enabled: boolean;
}

const TARGET_SQL = `
  SELECT s.contact_email, s.contact_phone, s.outreach_opted_out, s.customer_ref,
         s.amount_paise::text AS amount_paise, s.current_end,
         COALESCE(s.contact_language, 'en') AS contact_language, m.name AS merchant_name,
         c.kill_switch, m.write_enabled
    FROM subscription s
    JOIN merchant m ON m.id = s.merchant_id
    CROSS JOIN control_flags c
   WHERE s.id = $1 AND c.id = 1`;

export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['PUBLIC_BASE_URL']?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const hosted = env['RENDER_EXTERNAL_URL'] ?? env['FLY_APP_NAME'] ?? env['VERCEL_URL'];
  if (hosted) {
    const url = hosted.startsWith('http') ? hosted : `https://${hosted}`;
    return url.replace(/\/+$/, '');
  }

  return `http://localhost:${env['PORT'] ?? 3000}`;
}

function linkFor(token: string): string {
  return `${publicBaseUrl()}/r/${token}`;
}



async function claim(client: PoolClient, key: string, req: OutreachRequest, target: Target, now: Date) {
  const channel = pickChannel(target.contact_email, target.contact_phone);
  const token = outreachToken();
  const expires = outreachExpiry(now, target.current_end);
  const recipient = channel === 'email' ? target.contact_email : target.contact_phone;

  const { rowCount } = await client.query(
    `INSERT INTO outreach (
       decision_id, subscription_id, cycle, idempotency_key, token,
       channel, status, recipient_masked, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [req.decision_id, req.subscription_id, req.cycle, key, token,
     channel, maskRecipient(recipient), expires],
  );

  return rowCount === 1 ? { token, channel, recipient } : null;
}

export async function sendOutreach(
  req: OutreachRequest,
  provider: OutreachProvider,
): Promise<OutreachResult> {
  const now = req.now ?? new Date();
  const key = outreachIdempotencyKey(req);

  const { rows } = await query<Target>(TARGET_SQL, [req.subscription_id]);
  const target = rows[0];

  if (!target) return { status: 'blocked', key, reason: 'subscription not found' };
  if (target.kill_switch) return { status: 'blocked', key, reason: 'kill switch engaged' };
  if (!target.write_enabled) return { status: 'blocked', key, reason: 'merchant write access not granted' };
  if (target.outreach_opted_out) return { status: 'blocked', key, reason: 'customer opted out of outreach' };

  const sendable = nextSendableTime(now);
  if (sendable.getTime() !== now.getTime()) {
    return { status: 'deferred', key, until: sendable };
  }

  const claimed = await withTransaction((client) => claim(client, key, req, target, now));
  if (!claimed) return { status: 'duplicate', key };

  const { token, channel, recipient } = claimed;

  if (channel === 'none' || !recipient) {
    await query(
      `UPDATE outreach SET status = 'queued', error = $2 WHERE idempotency_key = $1`,
      [key, 'no contact details on file for this customer'],
    );
    return { status: 'queued', key, token, channel, reason: 'no contact details on file' };
  }

  if (config.dryRun) {
    await query(
      `UPDATE outreach SET status = 'queued', error = $2 WHERE idempotency_key = $1`,
      [key, 'dry run, nothing was sent'],
    );
    return { status: 'queued', key, token, channel, reason: 'dry run' };
  }

  const link = linkFor(token);
  const language = resolveLanguage(target.contact_language);
  const message = buildMessage({
    customer_ref: target.customer_ref,
    merchant_name: target.merchant_name,
    amount_paise: Number(target.amount_paise),
    link,
  }, language);

  await query(`UPDATE outreach SET language = $2 WHERE idempotency_key = $1`, [key, language]);

  const result = await provider.send({
    channel,
    recipient,
    subject: message.subject,
    body: message.body,
    link,
    subscription_id: req.subscription_id,
  });

  if (!result.ok) {
    await query(
      `UPDATE outreach SET status = $2, error = $3 WHERE idempotency_key = $1`,
      [key, result.retryable ? 'queued' : 'failed', result.error],
    );
    log.warn('outreach.not_delivered', {
      subscription_id: req.subscription_id, provider: provider.name, error: result.error,
    });
    return { status: 'queued', key, token, channel, reason: result.error };
  }

  await query(
    `UPDATE outreach SET status = 'sent', sent_at = clock_timestamp(), provider_ref = $2
      WHERE idempotency_key = $1`,
    [key, result.provider_ref],
  );

  log.info('outreach.sent', {
    subscription_id: req.subscription_id, channel, provider: provider.name,
  });

  return { status: 'sent', key, token, channel, provider_ref: result.provider_ref };
}
