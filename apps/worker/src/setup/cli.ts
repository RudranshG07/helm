import { close, query } from '@mandate/db';
import { DEFAULT_MANDATES, RazorpaySetup } from './razorpay.ts';

const keyId = process.env['RAZORPAY_KEY_ID'];
const keySecret = process.env['RAZORPAY_KEY_SECRET'];
const webhookUrl = process.argv[2];
const webhookSecret = process.env['RAZORPAY_WEBHOOK_SECRET_TEST'];
const merchantId = process.env['SETUP_MERCHANT_ID'] ?? 'helm_test_account';

if (!keyId || !keySecret) {
  console.error('Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env first.');
  process.exit(1);
}
if (!keyId.startsWith('rzp_test_')) {
  console.error('Refusing to run against a non test-mode key.');
  process.exit(1);
}

const setup = new RazorpaySetup({ keyId, keySecret });

const reach = await setup.whoami();
if (!reach.reachable) {
  console.error(`Razorpay rejected those keys — ${reach.problem}`);
  process.exit(1);
}
console.log('Keys work.\n');

await query(
  `INSERT INTO merchant (id, name, mode, integration, onboarding_state, cross_merchant_signals)
   VALUES ($1,'Helm test account','test','subscriptions','ready',TRUE)
   ON CONFLICT (id) DO UPDATE SET onboarding_state='ready'`,
  [merchantId],
);

if (webhookUrl && webhookSecret) {
  try {
    const hook = await setup.registerWebhook(`${webhookUrl.replace(/\/$/, '')}/webhooks/razorpay`, webhookSecret);
    console.log(`Webhook registered: ${hook.url}\n`);
  } catch (err) {
    console.log(`Could not register the webhook automatically (${(err as Error).message}).`);
    console.log('Add it by hand: Settings → Webhooks in the Razorpay dashboard.\n');
  }
} else {
  console.log('No webhook URL given, skipping webhook registration.\n');
}

const links: { label: string; url: string }[] = [];

for (const plan of DEFAULT_MANDATES) {
  const created = await setup.createPlan(plan.name, plan.amount_paise);
  console.log(`Plan  ${plan.name.padEnd(18)} ₹${plan.amount_paise / 100}  ${created.id}`);

  for (let i = 0; i < plan.count; i += 1) {
    const sub = await setup.createSubscription(created.id);
    if (sub.short_url) links.push({ label: `${plan.name} #${i + 1}`, url: sub.short_url });
  }
}

console.log(`\n${links.length} subscriptions created.\n`);
console.log('Open each link and complete authorisation with any test UPI ID.');
console.log('Use  success@razorpay  to authorise, then force failures from the dashboard.\n');
for (const l of links) console.log(`  ${l.label.padEnd(22)} ${l.url}`);

console.log('\nAfter authorising, in the Razorpay dashboard:');
console.log('  Subscriptions → pick one → "Charge this now" → choose Failure');
console.log('  That produces a real decline code and a real webhook.\n');

await close();
