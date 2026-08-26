#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const url = process.env.DATABASE_URL ?? 'postgres://mandate:mandate@localhost:5433/mandate_rescue';

const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`CREATE TABLE IF NOT EXISTS _migration (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

const { rows } = await client.query('SELECT name FROM _migration');
const applied = new Set(rows.map((r) => r.name));
const pending = readdirSync(dir).filter((f) => f.endsWith('.sql') && !applied.has(f)).sort();

for (const file of pending) {
  process.stdout.write(`applying ${file} ... `);
  try {
    await client.query('BEGIN');
    await client.query(readFileSync(join(dir, file), 'utf8'));
    await client.query('INSERT INTO _migration (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log('ok');
  } catch (err) {
    await client.query('ROLLBACK');
    console.log('failed');
    console.error(err.message);
    process.exit(1);
  }
}

console.log(pending.length === 0 ? 'up to date' : `${pending.length} migration(s) applied`);
await client.end();
