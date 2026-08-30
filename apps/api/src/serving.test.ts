import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '../../web');
const dist = join(webDir, 'dist');

describe('the marketing page and the product are one deployable site', () => {
  it('builds the landing page into the same output the API serves', () => {
    const config = readFileSync(join(webDir, 'vite.config.ts'), 'utf8');
    expect(config).toContain("publicDir");
    expect(config).not.toContain('publicDir: false');
    expect(config).toMatch(/publicDir:\s*resolve\([^)]*'landing'\)/);
  });

  it('keeps a landing page to copy', () => {
    expect(existsSync(join(webDir, 'landing/index.html'))).toBe(true);
  });

  it('points the landing page at the product, not only at itself', () => {
    const html = readFileSync(join(webDir, 'landing/index.html'), 'utf8');
    expect(html).toContain('href="/onboard"');
    expect(html).toContain('href="/dashboard"');
  });

  it('never leaves a call to action that goes nowhere', () => {
    const html = readFileSync(join(webDir, 'landing/index.html'), 'utf8');
    const deadButtons = html.match(/<button class="note-button"/g) ?? [];
    expect(deadButtons).toHaveLength(0);
  });

  it('serves every landing image from our own origin', () => {
    const html = readFileSync(join(webDir, 'landing/index.html'), 'utf8');
    const remote = html.match(/src="https?:\/\/[^"]+"/g) ?? [];
    expect(remote).toHaveLength(0);
  });

  it('keeps the landing page light enough for mobile data', () => {
    const imgDir = join(webDir, 'landing/img');
    if (!existsSync(imgDir)) return;
    const total = readdirSync(imgDir)
      .map((f) => readFileSync(join(imgDir, f)).byteLength)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(6 * 1024 * 1024);
  });

  it('ships the landing page whenever a build exists', () => {
    if (!existsSync(dist)) return;
    expect(existsSync(join(dist, 'index.html'))).toBe(true);
    expect(existsSync(join(dist, 'dashboard.html'))).toBe(true);
    expect(existsSync(join(dist, 'onboard.html'))).toBe(true);
    expect(existsSync(join(dist, 'authorize.html'))).toBe(true);
  });

  it('states the real number of policy rules', () => {
    const html = readFileSync(join(webDir, 'landing/index.html'), 'utf8');
    const policy = readFileSync(join(here, '../../../packages/core/src/policy.ts'), 'utf8');
    const ids = new Set(policy.match(/'R-[A-Z0-9-]+'/g) ?? []);
    ids.delete("'R-OK'");
    expect(html).toContain('sixteen deterministic rules');
    expect(ids.size).toBe(16);
  });
});
