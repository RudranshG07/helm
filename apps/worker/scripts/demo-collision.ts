import { close, query } from '@mandate/db';
import { analyzeDeconfliction, renderDeconfliction } from '../src/deconflict/analyze.ts';

const CUSTOMER = 'ck_9f2a7c41b8e3';
const MERCHANTS = [
  { id: 'demo_gym', name: 'Iron Works Gym', amount: 149900 },
  { id: 'demo_sip', name: 'Nivesh SIP', amount: 500000 },
  { id: 'demo_ott', name: 'StreamOne', amount: 19900 },
  { id: 'demo_emi', name: 'Kredit EMI', amount: 250000 },
];

const cycleStart = new Date();
const cycleEnd = new Date(cycleStart.getTime() + 30 * 86_400_000);
const paydayMidnight = new Date(Date.UTC(
  cycleStart.getUTCFullYear(), cycleStart.getUTCMonth(), cycleStart.getUTCDate() + 2, 18, 35,
));

for (const m of MERCHANTS) {
  const sub = `${m.id}:sub_shared`;
  await query(`DELETE FROM decision WHERE subscription_id = $1`, [sub]);
  await query(`DELETE FROM mandate_health WHERE subscription_id = $1`, [sub]);
  await query(`DELETE FROM payment_attempt WHERE subscription_id = $1`, [sub]);
  await query(`DELETE FROM subscription WHERE id = $1`, [sub]);
  await query(`DELETE FROM merchant WHERE id = $1`, [m.id]);

  await query(
    `INSERT INTO merchant (id, name, mode, write_enabled, cross_merchant_signals, integration)
     VALUES ($1,$2,'test',TRUE,TRUE,'recurring_tokens')`,
    [m.id, m.name],
  );
  await query(
    `INSERT INTO subscription (
       id, merchant_id, rzp_subscription_id, customer_ref, customer_key, method,
       amount_paise, status, current_start, current_end
     ) VALUES ($1,$2,'sub_shared','cust_shared',$3,'upi_autopay',$4,'pending',$5,$6)`,
    [sub, m.id, CUSTOMER, m.amount, cycleStart, cycleEnd],
  );
  await query(
    `INSERT INTO decision (
       subscription_id, cycle, proposed_action, proposed_by, verdict, rule_id,
       scheduled_for, rationale, explanation
     ) VALUES ($1,$2,'RETRY_SCHEDULED','allocator','ALLOW','R-OK',$3,
       'Prior successes cluster on payday.', 'All bounds satisfied.')`,
    [sub, cycleStart, paydayMidnight],
  );
}

const analysis = await analyzeDeconfliction();
console.log(renderDeconfliction(analysis));
await close();
