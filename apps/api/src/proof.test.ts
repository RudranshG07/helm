import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '../../web');

describe('the product is one connected path, not a pile of pages', () => {
  it('builds the proof page alongside the rest', () => {
    const config = readFileSync(join(web, 'vite.config.ts'), 'utf8');
    expect(config).toContain("'proof.html'");
    expect(existsSync(join(web, 'proof.html'))).toBe(true);
  });

  it('serves every page from the same origin as the api', () => {
    const server = readFileSync(join(here, 'server.ts'), 'utf8');
    for (const route of ['/dashboard', '/onboard', '/authorize', '/proof']) {
      expect(server, route).toContain(`'${route}'`);
    }
  });

  it('lets a visitor reach the proof from the landing page', () => {
    const landing = readFileSync(join(web, 'landing/index.html'), 'utf8');
    expect(landing).toContain('href="/proof"');
  });

  it('lets a visitor reach every other surface from inside the product', () => {
    for (const page of ['src/App.tsx', 'src/onboard.tsx', 'src/authorize.tsx']) {
      const src = readFileSync(join(web, page), 'utf8');
      expect(src, page).toContain('href="/proof"');
    }
  });

  it('ships the proof page in a build when one exists', () => {
    const dist = join(web, 'dist');
    if (!existsSync(dist)) return;
    expect(existsSync(join(dist, 'proof.html'))).toBe(true);
  });
});
