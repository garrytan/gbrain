import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'gbrain-schema-active-invalid-pack-'));
  const init = await runCli(['init', '--pglite', '--no-embedding'], { home, cwd: home, timeoutMs: 60_000 });
  expect(init.exitCode).toBe(0);
  const config = await runCli(['config', 'set', 'schema_pack', 'missing-pack-example'], {
    home, cwd: home, timeoutMs: 60_000,
  });
  expect(config.exitCode).toBe(0);
}, 120_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('schema active with an invalid configured pack', () => {
  test('returns a schema-specific refusal with recovery guidance', async () => {
    const result = await runCli(['schema', 'active', '--json'], {
      home, cwd: home, env: { GBRAIN_SCHEMA_PACK: undefined }, timeoutMs: 60_000,
    });
    let document: { code?: string; message?: string; suggestion?: string } = {};
    try { document = JSON.parse(result.stdout); } catch { /* asserted below */ }
    expect(result.exitCode).not.toBe(0);
    expect(document.code).toBe('invalid_params');
    expect(document.message).toContain('missing-pack-example');
    expect(document.suggestion).toContain('gbrain schema list');
  }, 60_000);
});
