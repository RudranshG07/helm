import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OPERATOR_HEADER, isProtected, operatorApproved, operatorPassphrase } from './guard.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const original = process.env['OPERATOR_PASSPHRASE'];

afterEach(() => {
  if (original === undefined) delete process.env['OPERATOR_PASSPHRASE'];
  else process.env['OPERATOR_PASSPHRASE'] = original;
});

const req = (headers: Record<string, string> = {}, body?: unknown) =>
  ({ headers, body }) as never;

describe('actions that can move money need a passphrase', () => {
  it('stays open when none is configured, so local development is unaffected', () => {
    delete process.env['OPERATOR_PASSPHRASE'];
    expect(isProtected()).toBe(false);
    expect(operatorApproved(req())).toBe(true);
  });

  it('refuses a request with no passphrase once one is set', () => {
    process.env['OPERATOR_PASSPHRASE'] = 'letmein';
    expect(operatorApproved(req())).toBe(false);
  });

  it('refuses a wrong passphrase', () => {
    process.env['OPERATOR_PASSPHRASE'] = 'letmein';
    expect(operatorApproved(req({ [OPERATOR_HEADER]: 'nope' }))).toBe(false);
  });

  it('accepts the right one from a header', () => {
    process.env['OPERATOR_PASSPHRASE'] = 'letmein';
    expect(operatorApproved(req({ [OPERATOR_HEADER]: 'letmein' }))).toBe(true);
  });

  it('accepts it from the body, for callers that cannot set headers', () => {
    process.env['OPERATOR_PASSPHRASE'] = 'letmein';
    expect(operatorApproved(req({}, { operator: 'letmein' }))).toBe(true);
  });

  it('is not fooled by a prefix of the real passphrase', () => {
    process.env['OPERATOR_PASSPHRASE'] = 'letmein';
    expect(operatorApproved(req({ [OPERATOR_HEADER]: 'let' }))).toBe(false);
    expect(operatorApproved(req({ [OPERATOR_HEADER]: 'letmeinnn' }))).toBe(false);
  });

  it('treats an empty setting as no protection rather than an empty password', () => {
    process.env['OPERATOR_PASSPHRASE'] = '   ';
    expect(operatorPassphrase()).toBeNull();
  });

  it('compares in constant time', () => {
    const guard = readFileSync(join(root, 'apps/api/src/guard.ts'), 'utf8');
    expect(guard).toContain('timingSafeEqual');
  });
});

describe('only the dangerous actions are gated', () => {
  const read = (f: string) => readFileSync(join(root, 'apps/api/src', f), 'utf8');

  it('gates granting write access, the kill switch, and the batch', () => {
    for (const f of ['onboard.ts', 'control.ts', 'authorize.ts']) {
      expect(read(f), f).toContain('requireOperator');
    }
  });

  it('leaves every read open, so anyone can inspect without a password', () => {
    const dashboard = read('dashboard.ts');
    expect(dashboard).not.toContain('requireOperator');
  });

  it('never puts the passphrase in the blueprint', () => {
    const render = readFileSync(join(root, 'render.yaml'), 'utf8');
    expect(render).toMatch(/key: OPERATOR_PASSPHRASE\s+sync: false/);
  });

  it('prompts for it in the browser rather than failing silently', () => {
    const operator = readFileSync(join(root, 'apps/web/src/operator.ts'), 'utf8');
    expect(operator).toContain('window.prompt');
    expect(operator).toContain('sessionStorage');
    expect(operator, 'a wrong passphrase must not be remembered').toContain('forgetPassphrase');
  });
});
