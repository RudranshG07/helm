import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const render = readFileSync(join(root, 'render.yaml'), 'utf8');
const server = readFileSync(join(root, 'apps/api/src/server.ts'), 'utf8');

describe('the app can be deployed as a single free-tier service', () => {
  it('runs the worker inside the web process when asked', () => {
    expect(server).toContain("process.env['RUN_WORKER'] === 'true'");
    expect(server).toContain('startEmbeddedWorker');
  });

  it('binds the port before starting the worker, so a health check passes', () => {
    const listen = server.indexOf('await app.listen');
    const worker = server.indexOf("RUN_WORKER");
    expect(listen).toBeGreaterThan(-1);
    expect(worker).toBeGreaterThan(listen);
  });

  it('stops the worker on shutdown rather than leaking it', () => {
    expect(server).toContain('embedded?.stop()');
  });

  it('asks the host for a Node that supports our source', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const major = Number(/(\d+)/.exec(pkg.engines.node)![1]);
    expect(major, 'native type stripping needs Node 24+').toBeGreaterThanOrEqual(24);
    expect(existsSync(join(root, '.node-version'))).toBe(true);
    expect(render).toMatch(/NODE_VERSION[\s\S]{0,40}"2[4-9]"/);
  });

  it('runs migrations before serving', () => {
    expect(render).toMatch(/startCommand:.*migrate\.js.*server\.ts/);
  });

  it('gives the host a health check to hit', () => {
    expect(render).toContain('healthCheckPath: /health');
  });

  it('keeps every secret out of the blueprint', () => {
    for (const secret of ['DATABASE_URL', 'SECRET_MASTER_KEY', 'RAZORPAY_KEY_SECRET', 'GEMINI_API_KEY']) {
      expect(render, `${secret} must not be committed`).toMatch(
        new RegExp(`key: ${secret}\\s+sync: false`),
      );
    }
    expect(render).not.toMatch(/rzp_(test|live)_/);
    expect(render).not.toMatch(/AIza/);
  });

  it('starts in dry run, so a fresh deploy cannot move money', () => {
    expect(render).toMatch(/key: DRY_RUN\s+value: "true"/);
  });

  it('sizes the connection pool for a free-tier database', () => {
    expect(render).toMatch(/DATABASE_POOL_MAX\s+value: "[1-9]"/);
  });

  it('does not ask for a URL the host already knows', () => {
    expect(render, 'PUBLIC_BASE_URL is derived, not entered by hand')
      .not.toContain('PUBLIC_BASE_URL');
  });
});

describe('outreach links point at wherever the app is actually running', () => {
  const send = readFileSync(join(root, 'apps/worker/src/outreach/send.ts'), 'utf8');

  it('uses the address the host injects', () => {
    expect(send).toContain('RENDER_EXTERNAL_URL');
  });

  it('still lets a custom domain override it', () => {
    expect(send).toContain("env['PUBLIC_BASE_URL']");
  });

  it('never emits a link with a doubled slash', () => {
    expect(send).toMatch(/replace\(\/\\\/\+\$\//);
  });
});

describe('hosted Postgres works without hand editing', () => {
  const client = readFileSync(join(root, 'packages/db/src/client.ts'), 'utf8');

  it('turns SSL on for a remote host and off for local', () => {
    expect(client).toContain('needsSsl');
    expect(client).toContain('sslmode=disable');
  });

  it('lets the pool size be set by the host', () => {
    expect(client).toContain('DATABASE_POOL_MAX');
  });

  it('does not wait forever for a connection that will never come', () => {
    expect(client).toContain('connectionTimeoutMillis');
  });
});
