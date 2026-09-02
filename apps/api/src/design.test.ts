import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '../../web');
const tokens = readFileSync(join(web, 'landing/tokens.css'), 'utf8');
const landing = readFileSync(join(web, 'landing/styles.css'), 'utf8');
const dashboard = readFileSync(join(web, 'src/styles.css'), 'utf8');

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokens);
  if (!m) throw new Error(`token --${name} is not defined`);
  return m[1]!.trim();
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function rgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const h = hex[1]!;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const parts = /rgba?\(([^)]+)\)/.exec(value);
  if (!parts) throw new Error(`cannot parse colour ${value}`);
  const nums = parts[1]!.split(',').map((n) => Number(n.trim()));
  return [nums[0]!, nums[1]!, nums[2]!];
}

function alpha(value: string): number {
  const parts = /rgba\(([^)]+)\)/.exec(value);
  if (!parts) return 1;
  const nums = parts[1]!.split(',').map((n) => Number(n.trim()));
  return nums[3] ?? 1;
}

function over(fg: string, bg: string): [number, number, number] {
  const a = alpha(fg);
  const f = rgb(fg);
  const b = rgb(bg);
  return [0, 1, 2].map((i) => f[i]! * a + b[i]! * (1 - a)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: string, bg: string): number {
  const l1 = luminance(over(fg, bg));
  const l2 = luminance(rgb(bg));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const PAPER = () => token('paper');
const DEEP = () => token('deep');

describe('every colour we ship is readable', () => {
  it.each([
    ['paper', 'deep'],
    ['paper-faint', 'deep'],
    ['paper-hint', 'deep'],
    ['sky', 'deep'],
  ])('%s on %s clears AA for normal text', (fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['ink', 'ink-soft', 'ink-faint', 'good', 'warn', 'critical', 'unknown', 'sky-deep'])
    ('%s on paper clears AA for normal text', (fg) => {
      expect(contrast(token(fg), PAPER())).toBeGreaterThanOrEqual(4.5);
    });

  it('keeps the two grounds far apart', () => {
    expect(contrast(PAPER(), DEEP())).toBeGreaterThan(10);
  });
});

describe('the marketing page and the product share one design system', () => {
  it('both stylesheets import the same tokens', () => {
    expect(landing).toContain('tokens.css');
    expect(dashboard).toContain('tokens.css');
  });

  it('neither redefines the palette locally', () => {
    for (const [name, css] of [['landing', landing], ['dashboard', dashboard]] as const) {
      expect(css, name).not.toMatch(/--paper:\s*#/);
      expect(css, name).not.toMatch(/--ink:\s*#/);
    }
  });

  it('never asks the display face for a weight it does not have', () => {
    const weights = new Set<string>();
    for (const css of [landing, dashboard]) {
      for (const block of css.split('}')) {
        if (!block.includes('var(--display)')) continue;
        const m = /font-weight:\s*([^;]+);/.exec(block);
        if (m) weights.add(m[1]!.trim());
      }
    }
    for (const w of weights) {
      expect(['400', 'var(--display-weight)', 'normal'], `display weight ${w}`).toContain(w);
    }
  });

  it('does not depend on a font host that blocks cross-origin use', () => {
    for (const css of [landing, dashboard]) {
      expect(css).not.toContain('cloudfront.net');
      expect(css).not.toContain('Ogg Medium');
    }
  });

  it('keeps the product reachable on a phone', () => {
    expect(dashboard).not.toMatch(/\.site-links\s*\{\s*display:\s*none/);
  });
});
