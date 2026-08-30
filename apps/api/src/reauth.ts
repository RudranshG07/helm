import type { FastifyInstance } from 'fastify';
import { query } from '@mandate/db';

interface TokenRow {
  id: string;
  subscription_id: string;
  status: string;
  expires_at: Date;
  customer_ref: string;
  amount_paise: string;
  merchant_name: string;
}

const LOOKUP_SQL = `
  SELECT o.id::text AS id, o.subscription_id, o.status, o.expires_at,
         s.customer_ref, s.amount_paise::text AS amount_paise, m.name AS merchant_name
    FROM outreach o
    JOIN subscription s ON s.id = o.subscription_id
    JOIN merchant m ON m.id = s.merchant_id
   WHERE o.token = $1`;

function page(title: string, body: string, status: 'ok' | 'gone' = 'ok'): string {
  const accent = status === 'ok' ? '#1d5f7e' : '#c0392b';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap" />
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
         background:#0b1110; color:#111411; font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif; }
  .card { background:#fdf1e1; border-radius:24px; padding:40px 36px; max-width:520px; width:100%;
          box-shadow:0 18px 52px rgba(2,47,64,0.22); }
  h1 { font-family:"Instrument Serif",Georgia,serif; font-weight:400; font-size:2rem; line-height:1.1; margin:0 0 16px; }
  p { margin:0 0 16px; color:#3b423c; }
  .amount { font-size:2.4rem; font-weight:600; font-variant-numeric:tabular-nums; margin:8px 0 20px; }
  .cta { display:inline-flex; align-items:center; justify-content:center; min-height:48px; padding:0 26px;
         border-radius:999px; background:${accent}; color:#fdf1e1; text-decoration:none; font-weight:600; }
  .cta:focus-visible { outline:3px solid #4ab5e0; outline-offset:3px; }
  .quiet { font-size:0.85rem; color:#6b7280; margin-top:22px; }
  .quiet a { color:#6b7280; }
</style></head>
<body><main class="card">${body}</main></body></html>`;
}

export function registerReauthRoutes(app: FastifyInstance): void {
  app.get<{ Params: { token: string } }>('/r/:token', async (request, reply) => {
    const { rows } = await query<TokenRow>(LOOKUP_SQL, [request.params.token]);
    const row = rows[0];

    reply.type('text/html; charset=utf-8');
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');

    if (!row) {
      return reply.code(404).send(page('Link not found', `
        <h1>This link is not valid</h1>
        <p>It may have been mistyped, or it belonged to a request that has since been cancelled.</p>`, 'gone'));
    }

    if (row.status === 'revoked' || new Date(row.expires_at) < new Date()) {
      await query(`UPDATE outreach SET status = 'expired' WHERE id = $1 AND status <> 'converted'`, [row.id]);
      return reply.code(410).send(page('Link expired', `
        <h1>This link has expired</h1>
        <p>Please contact ${row.merchant_name} if you still want to keep the subscription active.</p>`, 'gone'));
    }

    if (row.status === 'converted') {
      return reply.send(page('Already re-authorised', `
        <h1>You are all set</h1>
        <p>This subscription has already been re-authorised. Nothing further is needed.</p>`));
    }

    await query(
      `UPDATE outreach SET status = 'viewed', viewed_at = COALESCE(viewed_at, clock_timestamp())
        WHERE id = $1 AND status IN ('queued','sent')`,
      [row.id],
    );

    const rupees = `₹${Math.round(Number(row.amount_paise) / 100).toLocaleString('en-IN')}`;
    return reply.send(page('Re-authorise your subscription', `
      <h1>Your payment could not be collected</h1>
      <p>${row.merchant_name} was unable to collect your monthly payment, and your bank will not
         allow another attempt on the current authorisation.</p>
      <div class="amount">${rupees}<span style="font-size:1rem;font-weight:400;color:#6b7280;"> per month</span></div>
      <p>Re-authorise to keep the subscription active.</p>
      <a class="cta" href="/authorize?token=${encodeURIComponent(request.params.token)}">Re-authorise</a>
      <p class="quiet">
        Would rather stop? <a href="/r/${encodeURIComponent(request.params.token)}/stop">Cancel and stop these messages</a>.
      </p>`));
  });

  app.get<{ Params: { token: string } }>('/r/:token/stop', async (request, reply) => {
    const { rows } = await query<TokenRow>(LOOKUP_SQL, [request.params.token]);
    const row = rows[0];

    reply.type('text/html; charset=utf-8');
    reply.header('cache-control', 'no-store');

    if (!row) return reply.code(404).send(page('Link not found', '<h1>This link is not valid</h1>', 'gone'));

    await query(`UPDATE subscription SET outreach_opted_out = TRUE WHERE id = $1`, [row.subscription_id]);
    await query(`UPDATE outreach SET status = 'revoked' WHERE subscription_id = $1 AND status IN ('queued','sent','viewed')`,
      [row.subscription_id]);

    app.log.info({ event: 'outreach.opted_out', subscription_id: row.subscription_id });

    return reply.send(page('Stopped', `
      <h1>You will not hear from us again</h1>
      <p>We have stopped messages about this subscription. No further payment will be attempted.</p>`));
  });
}
