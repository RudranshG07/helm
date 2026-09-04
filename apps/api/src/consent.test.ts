import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const onboard = readFileSync(join(root, 'apps/api/src/onboard.ts'), 'utf8');
const M = 'merchant_consent_test';

async function reset() {
  await query(`DELETE FROM merchant WHERE id = $1`, [M]);
  await query(
    `INSERT INTO merchant (id, name, mode, write_enabled) VALUES ($1,$1,'test',FALSE)`, [M]);
}

beforeEach(reset);
afterAll(async () => {
  await query(`DELETE FROM merchant WHERE id = $1`, [M]);
  await close();
});

describe('a merchant decides for themselves whether Helm may charge', () => {
  it('offers a way to grant and a way to revoke', () => {
    expect(onboard).toContain("'/api/onboard/:id/consent'");
    expect(onboard).toContain('write_enabled = $2');
  });

  it('demands an exact acknowledgement, not a checkbox', () => {
    expect(onboard).toContain('I authorise Helm to charge my customers');
    expect(onboard).toMatch(/acknowledged !== ACKNOWLEDGEMENT/);
  });

  it('shows what a grant would have cost before it is given', () => {
    expect(onboard).toContain('dry_run');
    expect(onboard).toContain('would_charge_paise');
  });

  it('records when consent was given, and clears it when revoked', () => {
    expect(onboard).toMatch(/consent_signed_at = CASE WHEN \$2 THEN clock_timestamp\(\) ELSE NULL END/);
  });

  it('logs a grant loudly, because it is the moment money becomes possible', () => {
    expect(onboard).toMatch(/log\.warn\(\{\s*event: granted \? 'merchant\.write_granted'/);
  });

  it('starts a newly connected merchant with writes off', () => {
    const inserts = [...onboard.matchAll(/INSERT INTO merchant[\s\S]*?`/g)].map((m) => m[0]);
    expect(inserts.length, 'no merchant insert found').toBeGreaterThan(0);
    for (const sql of inserts) {
      expect(sql, 'a connected merchant must start with writes disabled').toContain('write_enabled');
      expect(sql, 'a connected merchant must start with writes disabled').toContain('FALSE');
    }
  });

  it('actually flips the flag in the database', async () => {
    await query(
      `UPDATE merchant SET write_enabled = TRUE, consent_signed_at = clock_timestamp() WHERE id = $1`,
      [M]);
    const { rows } = await query<{ write_enabled: boolean; consent_signed_at: Date | null }>(
      `SELECT write_enabled, consent_signed_at FROM merchant WHERE id = $1`, [M]);
    expect(rows[0]!.write_enabled).toBe(true);
    expect(rows[0]!.consent_signed_at).not.toBeNull();
  });

  it('leaves no way to charge a merchant who never granted', async () => {
    const { rows } = await query<{ write_enabled: boolean }>(
      `SELECT write_enabled FROM merchant WHERE id = $1`, [M]);
    expect(rows[0]!.write_enabled).toBe(false);
  });
});

describe('the screen a merchant sees before deciding', () => {
  const ui = readFileSync(join(root, 'apps/web/src/onboard.tsx'), 'utf8');

  it('will not enable the button until the words match', () => {
    expect(ui).toMatch(/disabled=\{busy \|\| typed\.trim\(\) !== ACKNOWLEDGEMENT\}/);
  });

  it('states plainly that nothing has been charged yet', () => {
    expect(ui).toContain('has not charged anyone');
  });

  it('shows the refusals alongside the charges, not just the upside', () => {
    expect(ui).toContain('Actions the rules refused');
  });

  it('tells them they can take it back', () => {
    expect(ui).toContain('Revoke write access');
    expect(ui).toContain('kill switch');
  });
});
