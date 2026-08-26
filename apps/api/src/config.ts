function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env['PORT'] ?? 3000),
  host: process.env['HOST'] ?? '0.0.0.0',
  databaseUrl: required('DATABASE_URL'),
  mode: (process.env['RAZORPAY_MODE'] ?? 'test') as 'test' | 'live',
  dryRun: process.env['DRY_RUN'] !== 'false',
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
};

export function webhookSecret(mode: 'test' | 'live'): string {
  return required(mode === 'live' ? 'RAZORPAY_WEBHOOK_SECRET_LIVE' : 'RAZORPAY_WEBHOOK_SECRET_TEST');
}
