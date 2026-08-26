import { close, query } from '@mandate/db';
import { runBacktest } from './src/backtest/run.ts';
const MERCHANT = 'merchant_backtest';
const SUB = `${MERCHANT}:sub_bt`;
await query(`DELETE FROM payment_attempt WHERE subscription_id = $1`, [SUB]);
await query(`INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise, error_reason, initiated_by)
             VALUES ($1,'2026-06-01','2026-06-01T10:00:00Z','failed',49900,'insufficient_funds','razorpay_default')`, [SUB]);
const r = await runBacktest(MERCHANT);
console.log(JSON.stringify(r.decision_points[0], null, 2));
await close();
