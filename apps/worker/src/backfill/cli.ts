import { close } from '@mandate/db';
import { RazorpayReader } from './client.ts';
import { backfill } from './run.ts';

const merchantId = process.argv[2];
const days = Number(process.argv[3] ?? 180);

if (!merchantId) {
  console.error('Usage: node src/backfill/cli.ts <merchant_id> [days_back]');
  process.exit(1);
}

const keyId = process.env['RAZORPAY_KEY_ID'];
const keySecret = process.env['RAZORPAY_KEY_SECRET'];

if (!keyId || !keySecret) {
  console.error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set. Read-only keys are enough.');
  process.exit(1);
}

const to = new Date();
const from = new Date(to.getTime() - days * 86_400_000);

const reader = new RazorpayReader({ keyId, keySecret });
const result = await backfill(reader, merchantId, from, to);

console.log(JSON.stringify(result, null, 2));
await close();
