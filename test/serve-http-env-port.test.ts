/**
 * `gbrain serve --http` reads $PORT and $GBRAIN_PUBLIC_URL when the flags are
 * absent, so a container image can run `gbrain serve --http --bind 0.0.0.0`
 * and take the port and OAuth issuer from the platform's service config.
 * Flags always win. Driven through the runServeHttp seam; no server boots.
 */
import { describe, test, expect } from 'bun:test';
import { runServe, resolveEnvPort, type ServeOptions } from '../src/commands/serve.ts';
import type { BrainEngine } from '../src/core/engine.ts';

async function serveWith(args: string[], env: Record<string, string | undefined>) {
  let seen: { port: number; publicUrl?: string; bind?: string } | undefined;
  const logs: string[] = [];
  const engine = { disconnect: async () => {} };
  const opts: ServeOptions = {
    env,
    exit: () => {},
    log: (m) => { logs.push(m); },
    stallWatchdogMs: 0,
    runServeHttp: (async (_e: unknown, o: { port: number; publicUrl?: string; bind?: string }) => { seen = o; }) as ServeOptions['runServeHttp'],
  };
  await runServe(engine as unknown as BrainEngine, ['--http', ...args], opts);
  return { seen: seen!, logs };
}

describe('serve --http environment defaults', () => {
  test('uses $PORT and $GBRAIN_PUBLIC_URL when the flags are absent', async () => {
    const { seen } = await serveWith(['--bind', '0.0.0.0'], { PORT: '8080', GBRAIN_PUBLIC_URL: 'https://brain.example.com' });
    expect(seen.port).toBe(8080);
    expect(seen.publicUrl).toBe('https://brain.example.com');
    expect(seen.bind).toBe('0.0.0.0');
  });

  test('explicit flags win over the environment', async () => {
    const { seen } = await serveWith(['--port', '9090', '--public-url', 'https://flag.example.com'], { PORT: '8080', GBRAIN_PUBLIC_URL: 'https://env.example.com' });
    expect(seen.port).toBe(9090);
    expect(seen.publicUrl).toBe('https://flag.example.com');
  });

  test('defaults are unchanged without the environment', async () => {
    const { seen } = await serveWith([], {});
    expect(seen.port).toBe(3131);
    expect(seen.publicUrl).toBeUndefined();
    expect(seen.bind).toBeUndefined();
  });

  test('an empty GBRAIN_PUBLIC_URL is treated as unset', async () => {
    const { seen } = await serveWith([], { GBRAIN_PUBLIC_URL: '' });
    expect(seen.publicUrl).toBeUndefined();
  });

  test('an invalid $PORT falls back to 3131 with a warning', async () => {
    const { seen, logs } = await serveWith([], { PORT: 'abc' });
    expect(seen.port).toBe(3131);
    expect(logs.some((l) => l.includes('ignoring PORT="abc"'))).toBe(true);
  });
});

describe('resolveEnvPort', () => {
  const quiet = () => {};
  test.each([['1', 1], ['8080', 8080], ['65535', 65535]])('accepts %s', (raw, want) => {
    expect(resolveEnvPort(raw, quiet)).toBe(want);
  });
  test.each(['0', '65536', '-1', '80.5', ' 80', '8080x', 'abc'])('rejects %s', (raw) => {
    const warnings: string[] = [];
    expect(resolveEnvPort(raw, (m) => warnings.push(m))).toBe(3131);
    expect(warnings.length).toBe(1);
  });
  test('unset or empty is the default, silently', () => {
    const warnings: string[] = [];
    expect(resolveEnvPort(undefined, (m) => warnings.push(m))).toBe(3131);
    expect(resolveEnvPort('', (m) => warnings.push(m))).toBe(3131);
    expect(warnings).toEqual([]);
  });
});
