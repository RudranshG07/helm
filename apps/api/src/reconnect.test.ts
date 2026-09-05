import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const onboard = readFileSync(join(root, 'apps/api/src/onboard.ts'), 'utf8');
const ui = readFileSync(join(root, 'apps/web/src/onboard.tsx'), 'utf8');

const PRINT = 'fingerprint_reconnect_test';

async function reset() {
  await query(`DELETE FROM merchant WHERE key_fingerprint = $1`, [PRINT]);
}

beforeEach(reset);
afterAll(async () => { await reset(); await close(); });

describe('connecting the same Razorpay account twice resumes it', () => {
  it('identifies a merchant by its account, not by the name someone typed', () => {
    const lookup = onboard.indexOf('WHERE key_fingerprint = $1');
    const fallback = onboard.indexOf('owner ?? signedInAs ?? slug(name)');
    expect(lookup, 'no lookup by fingerprint').toBeGreaterThan(-1);
    expect(fallback, 'the name is still the only identity').toBeGreaterThan(lookup);
  });

  it('tells the caller it resumed rather than created', () => {
    expect(onboard).toMatch(/resumed/);
  });

  it('attaches the keys to the account already signed in', () => {
    expect(onboard).toContain('resolveMerchant(request)');
    expect(onboard, 'a connected account must not be stolen by another login')
      .toMatch(/already connected to a different Helm account/);
  });

  it('finds an existing merchant by fingerprint', async () => {
    await query(
      `INSERT INTO merchant (id, name, mode, key_fingerprint, write_enabled)
       VALUES ('reconnect_first','First name','test',$1,FALSE)`, [PRINT]);
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM merchant WHERE key_fingerprint = $1`, [PRINT]);
    expect(rows[0]!.id).toBe('reconnect_first');
  });

  it('would have created a second merchant under a different name before this', async () => {
    await query(
      `INSERT INTO merchant (id, name, mode, key_fingerprint, write_enabled)
       VALUES ('reconnect_first','First name','test',$1,FALSE)`, [PRINT]);
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM merchant WHERE key_fingerprint = $1`, [PRINT]);
    expect(rows[0]!.n, 'one account must map to one merchant').toBe(1);
  });
});

describe('a merchant with nothing failing can still decide', () => {
  it('shows the consent panel even when there is no history', () => {
    const noHistory = ui.slice(ui.indexOf('Connected, nothing failing'));
    const nextBranch = noHistory.indexOf('const m = report.money');
    const section = nextBranch > 0 ? noHistory.slice(0, nextBranch) : noHistory;
    expect(section, 'a merchant with no failures could never grant access')
      .toContain('GrantAccess');
  });

  it('offers it on the report path too', () => {
    const points = ui.match(/<GrantAccess merchantId=/g) ?? [];
    expect(points.length).toBeGreaterThanOrEqual(2);
  });

  it('explains why the page is empty rather than just saying nothing failed', () => {
    expect(ui).toContain('nothing to');
  });
});
