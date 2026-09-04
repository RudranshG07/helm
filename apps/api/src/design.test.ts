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

  it('defines every colour once, in the token file', () => {
    for (const [name, css] of [['landing', landing], ['dashboard', dashboard]] as const) {
      const literals = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(literals, `${name} should use tokens, found ${literals.join(', ')}`).toHaveLength(0);
    }
  });

  it('leaves no variable undefined', () => {
    const defined = new Set([...tokens.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    for (const [name, css] of [['landing', landing], ['dashboard', dashboard]] as const) {
      const local = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
      const used = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]!));
      const missing = [...used].filter((v) => !defined.has(v) && !local.has(v));
      expect(missing, `${name} uses undefined ${missing.join(', ')}`).toHaveLength(0);
    }
  });

  it('scales display type fluidly rather than at a few breakpoints', () => {
    expect(tokens).toMatch(/--step-hero:\s*clamp\(/);
    expect(tokens).toMatch(/--step-xl:\s*clamp\(/);
  });
});

describe('content arrives rather than snapping into place', () => {
  const skeletons = readFileSync(join(web, 'src/skeletons.tsx'), 'utf8');
  const reveal = readFileSync(join(web, 'src/reveal.ts'), 'utf8');

  it('animates only when the viewer has not asked for less motion', () => {
    const guarded = /@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/g;
    const inside = [...dashboard.matchAll(guarded)].map((m) => m[1]!).join('');
    expect(inside).toContain('animation: rise');
    expect(inside).toContain('[data-reveal=');
  });

  it('shows content immediately when motion is reduced', () => {
    expect(dashboard).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?data-reveal='pending'[^}]*opacity: 1/);
  });

  it('reveals long pages on scroll, not all at once on mount', () => {
    expect(reveal).toContain('IntersectionObserver');
    for (const page of ['src/proof.tsx', 'src/docs.tsx']) {
      expect(readFileSync(join(web, page), 'utf8'), page).toContain('useReveal');
    }
  });

  it('falls back to visible content where the observer is unavailable', () => {
    expect(reveal).toContain("'IntersectionObserver' in window");
    expect(reveal).toMatch(/t\.dataset\['revealed'\] = 'true'/);
  });

  it('shapes every skeleton like the content it stands in for', () => {
    for (const shape of ['tile-shape', 'row-shape', 'title-shape', 'line-shape']) {
      expect(dashboard, shape).toContain(shape);
    }
    expect(skeletons).toContain('SkeletonReport');
    expect(skeletons).toContain('SkeletonTable');
  });

  it('leaves no generic loading slab behind', () => {
    for (const page of ['src/App.tsx', 'src/views.tsx', 'src/proof.tsx',
                        'src/docs.tsx', 'src/onboard.tsx', 'src/authorize.tsx']) {
      expect(readFileSync(join(web, page), 'utf8'), page).not.toContain('skeleton tall');
    }
  });

  it('tells a screen reader what is loading', () => {
    expect(skeletons).toContain("role=\"status\"");
    expect(skeletons).toContain('visually-hidden');
  });

  it('reports progress on work that takes seconds', () => {
    const proof = readFileSync(join(web, 'src/proof.tsx'), 'utf8');
    expect(proof).toContain('aria-live="polite"');
    expect(proof).toMatch(/setStep\(/);
  });
});

describe('the landing page works without the scroll choreography', () => {
  const html = readFileSync(join(web, 'landing/index.html'), 'utf8');

  it('points its navigation at targets that exist in the document', () => {
    for (const m of html.matchAll(/href="#([a-z-]+)"/g)) {
      expect(html, `#${m[1]} has no target`).toContain(`id="${m[1]}"`);
    }
  });

  it('keeps every call to action outside the animated panels', () => {
    const ground = /<div class="ground">([\s\S]*)<\/div>\s*<\/main>/.exec(html);
    expect(ground, 'no always-visible ground section').not.toBeNull();
    for (const route of ['/proof', '/onboard', '/dashboard', '/docs']) {
      expect(ground![1], route).toContain(`href="${route}"`);
    }
  });

  it('carries no control that does nothing', () => {
    expect(html).not.toContain('language-switcher');
  });

  it('states the rule count the engine actually implements', () => {
    const policy = readFileSync(join(here, '../../../packages/core/src/policy.ts'), 'utf8');
    const ids = new Set(policy.match(/'R-[A-Z0-9-]+'/g) ?? []);
    ids.delete("'R-OK'");
    expect(ids.size).toBe(16);
    expect(html).not.toMatch(/Fourteen|fourteen/);
    expect(html).toMatch(/[Ss]ixteen/);
  });

  it('reserves no space for controls that were removed', () => {
    expect(landing).not.toContain('language-switcher');
    const header = /\.site-header \{([^}]*)\}/.exec(landing);
    expect(header, 'no .site-header rule').not.toBeNull();
    const fixedSideColumns = /minmax\(\s*\d+px/.exec(header![1]!);
    expect(fixedSideColumns, 'a fixed side column squeezes the nav until it clips').toBeNull();
  });

  it('lets the navigation wrap rather than clip its own call to action', () => {
    const nav = /\.site-nav \{([^}]*)\}/.exec(landing);
    expect(nav, 'no .site-nav rule').not.toBeNull();
    expect(nav![1]).toContain('flex-wrap: wrap');
    expect(nav![1]).toContain('min-width: 0');
  });

  it('leaves the scroll choreography untouched', () => {
    const bridge = /\.bridge-img \{([^}]*)\}/.exec(landing);
    expect(bridge, 'no .bridge-img rule').not.toBeNull();
    expect(bridge![1], 'the bridge is animated by width and scale; a height cap clamps it')
      .not.toMatch(/max-height/);
    expect(bridge![1]).toContain('var(--bridge-width)');
    expect(bridge![1]).toContain('var(--bridge-scale)');
  });

  it('offers every destination from the top of the landing page', () => {
    const nav = /<nav class="site-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
    expect(nav, 'no site nav').not.toBeNull();
    for (const route of ['/proof', '/docs', '/dashboard', '/onboard']) {
      expect(nav![1], route).toContain(`href="${route}"`);
    }
  });

  it('keeps the wordmark tucked behind the bridge, as the scene intends', () => {
    const zOf = (selector: string) => {
      const rule = new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(landing);
      expect(rule, `${selector} has no rule`).not.toBeNull();
      const z = /z-index:\s*(\d+)/.exec(rule![1]!);
      expect(z, `${selector} has no z-index`).not.toBeNull();
      return Number(z![1]);
    };
    expect(zOf('.hero-title')).toBeLessThan(zOf('.bridge-img'));
  });

  it('never lets the bridge swallow the wordmark completely', () => {
    const rule = /\.hero-title \{([^}]*)\}/.exec(landing);
    expect(rule, 'no .hero-title rule').not.toBeNull();
    const top = /top:\s*([^;]+);/.exec(rule![1]!);
    expect(top, 'hero title has no top').not.toBeNull();
    expect(top![1], 'the title must rise when the bridge grows tall on a short viewport')
      .toMatch(/95vh\s*-\s*38\.2vw/);

    const ASPECT = 2200 / 1237;
    const visible = (vw: number, vh: number, fontRem: number) => {
      const w = Math.min(0.672 * vw, 2140);
      const h = w / ASPECT;
      const bridgeTop = vh - 0.05 * vh - h - h * 0.02 * 0.48;
      const inner = Math.min(0.19 * vh, 0.95 * vh - 0.382 * vw - 60);
      const titleTop = Math.max(90, Math.min(inner, 205));
      return Math.min(bridgeTop, titleTop + fontRem * 16 * 0.78) - titleTop;
    };

    const ratios: [number, number, number][] = [
      [1440, 900, 11], [1440, 700, 11], [1366, 768, 11], [1280, 800, 11],
      [1920, 1080, 14], [1920, 900, 14], [2560, 1440, 14], [1024, 768, 7.5], [390, 844, 4.5],
    ];
    for (const [vw, vh, font] of ratios) {
      expect(visible(vw, vh, font), `${vw}x${vh} hides the wordmark`).toBeGreaterThan(20);
    }
  });

  it('centres the primary navigation without reserving fixed side columns', () => {
    const header = /\.site-header \{([^}]*)\}/.exec(landing);
    expect(header![1]).toContain('justify-items: center');
    expect(header![1]).not.toMatch(/minmax\(2\d\dpx/);
  });

  it('never lists the same destination twice in one navigation', () => {
    for (const [name, re_] of [
      ['header', /<nav class="site-nav"[\s\S]*?<\/nav>/],
      ['footer', /<nav aria-label="Footer">[\s\S]*?<\/nav>/],
    ] as const) {
      const block = re_.exec(html);
      expect(block, `${name} nav missing`).not.toBeNull();
      const hrefs = [...block![0].matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
      expect(new Set(hrefs).size, `${name} has a duplicate link`).toBe(hrefs.length);
    }
  });

  it('gives narrow screens a layout instead of a broken wide one', () => {
    expect(landing).toMatch(/@media \(max-width: 860px\)/);
    expect(landing).toContain('.ground-actions { flex-direction: column');
  });
});
