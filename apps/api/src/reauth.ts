import type { FastifyInstance } from 'fastify';
import { query } from '@mandate/db';
import { recordPromise } from '@mandate/worker/promise';

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
  .promise { margin-top:26px; padding-top:22px; border-top:1px solid rgba(17,20,17,0.12); }
  .promise h2 { font-family:"Instrument Serif",Georgia,serif; font-weight:400; font-size:1.25rem; margin:0 0 8px; }
  .promise form { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:12px; }
  .promise label { font-size:0.9rem; color:#3b423c; width:100%; }
  .promise input { min-height:46px; padding:0 14px; border-radius:12px; border:1px solid rgba(17,20,17,0.22);
                   font:inherit; background:#fff; color:#111411; }
  .promise input:focus-visible { outline:3px solid #4ab5e0; outline-offset:2px; }
  .promise button { min-height:46px; padding:0 22px; border-radius:999px; border:0; cursor:pointer;
                    background:#111411; color:#fdf1e1; font:inherit; font-weight:600; }
  .promise button:focus-visible { outline:3px solid #4ab5e0; outline-offset:3px; }
  .note { margin-top:14px; padding:12px 14px; border-radius:12px; font-size:0.88rem; }
  .note-ok { background:rgba(47,125,91,0.14); color:#1f5a41; }
  .note-bad { background:rgba(192,57,43,0.12); color:#8c2b20; }
</style></head>
<body><main class="card">${body}</main></body></html>`;
}

export function registerReauthRoutes(app: FastifyInstance): void {
  app.get<{ Params: { token: string }; Querystring: { promised?: string; problem?: string } }>(
    '/r/:token',
    async (request, reply) => {
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
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
    const today = day(0);
    const horizon = day(21);
    const suggested = day(3);
    const flag = (request.query as { promised?: string; problem?: string } | undefined);
    const notice = flag?.promised
      ? `<div class="note note-ok">Noted. We will try again on ${flag.promised}, not before.</div>`
      : flag?.problem
        ? `<div class="note note-bad">${flag.problem.replace(/[<>&]/g, '')}</div>`
        : '';
    return reply.send(page('Re-authorise your subscription', `
      <h1>Your payment could not be collected</h1>
      <p>${row.merchant_name} was unable to collect your monthly payment, and your bank will not
         allow another attempt on the current authorisation.</p>
      <div class="amount">${rupees}<span style="font-size:1rem;font-weight:400;color:#6b7280;"> per month</span></div>
      <p>Re-authorise to keep the subscription active.</p>
      <a class="cta" href="/authorize?token=${encodeURIComponent(request.params.token)}">Re-authorise</a>

      <div class="promise">
        <h2>Short on funds right now?</h2>
        <p>Tell us when you will have them and we will wait, instead of retrying and failing again.</p>
        <form method="POST" action="/r/${encodeURIComponent(request.params.token)}/promise">
          <label for="promised_for">I will have funds by</label>
          <input type="date" id="promised_for" name="promised_for" required
                 min="${today}" max="${horizon}" value="${suggested}" />
          <button type="submit">Set the date</button>
        </form>
        ${notice}
      </div>

      <p class="quiet">
        Would rather stop? <a href="/r/${encodeURIComponent(request.params.token)}/stop">Cancel and stop these messages</a>.
      </p>`));
    },
  );

  app.post<{ Params: { token: string }; Body: { promised_for?: string } }>(
    '/r/:token/promise',
    async (request, reply) => {
      const { rows } = await query<TokenRow>(LOOKUP_SQL, [request.params.token]);
      const row = rows[0];
      const back = `/r/${encodeURIComponent(request.params.token)}`;

      if (!row) return reply.code(404).send(page('Link not found', '<h1>This link is not valid</h1>', 'gone'));
      if (new Date(row.expires_at) < new Date()) {
        return reply.redirect(`${back}?problem=${encodeURIComponent('That link has expired.')}`);
      }

      const result = await recordPromise({
        subscription_id: row.subscription_id,
        outreach_id: row.id,
        promised_for: String(request.body?.promised_for ?? ''),
      });

      if (!result.ok) {
        return reply.redirect(`${back}?problem=${encodeURIComponent(result.error)}`);
      }

      app.log.info({
        event: 'promise.accepted',
        subscription_id: row.subscription_id,
        promised_for: result.promised_for,
      });
      return reply.redirect(`${back}?promised=${encodeURIComponent(result.promised_for)}`);
    },
  );

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
