import { writeFileSync } from 'node:fs';
import { close } from '@mandate/db';
import { loadCsv, renderImport } from './csv.ts';

const path = process.argv[2];
const merchantId = process.argv[3];
const out = process.argv[4];
const dryRun = process.argv.includes('--dry-run');

if (!path || !merchantId) {
  console.error('Usage: node src/import/cli.ts <file.csv> <merchant_id> [out.md] [--dry-run]');
  process.exit(1);
}

const result = await loadCsv(path, merchantId, { dryRun });
const markdown = renderImport(result, path, merchantId);

if (out) writeFileSync(out, markdown);
else console.log(markdown);

console.error(
  `read ${result.report.attempts.length}/${result.report.rows_seen} rows · ` +
    `${result.attempts_inserted} inserted · ${result.attempts_duplicate} already present · ` +
    `${result.subscriptions_created} subscriptions${dryRun ? ' (dry run, nothing written)' : ''}`,
);
await close();
