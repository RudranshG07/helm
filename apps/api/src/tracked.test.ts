import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.(ts|tsx|sql|css|html)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

function ignored(paths: string[]): string[] {
  if (paths.length === 0) return [];
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: root,
      input: paths.map((p) => relative(root, p)).join('\n'),
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('everything the application imports actually ships', () => {
  it('has no source file excluded from the repository', () => {
    const files = [
      ...sourceFiles(join(root, 'apps')),
      ...sourceFiles(join(root, 'packages')),
    ];
    expect(files.length).toBeGreaterThan(50);

    const excluded = ignored(files);
    expect(
      excluded,
      `these are imported at runtime but never reach a deploy:\n${excluded.join('\n')}`,
    ).toHaveLength(0);
  });

  it('anchors directory patterns so they cannot swallow nested source', () => {
    const gitignore = readdirSync(root).includes('.gitignore')
      ? execFileSync('cat', ['.gitignore'], { cwd: root, encoding: 'utf8' })
      : '';
    const generic = ['docs/', 'data/', 'build/', 'imports/', 'secrets/', 'keys/'];
    for (const pattern of generic) {
      const unanchored = new RegExp(`^${pattern.replace('/', '\\/')}$`, 'm');
      expect(
        unanchored.test(gitignore),
        `"${pattern}" is unanchored and will match that directory at any depth`,
      ).toBe(false);
    }
  });

  it('still keeps generated reports and secrets out', () => {
    expect(ignored([join(root, 'docs/adversarial.md')])).toHaveLength(1);
    expect(ignored([join(root, '.env')])).toHaveLength(1);
  });
});
