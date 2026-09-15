import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

test('documented schema_pack config command writes and reads the brain-wide DB tier without force', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-schema-config-'));
  homes.push(home);
  mkdirSync(join(home, '.gbrain'));
  const configPath = join(home, '.gbrain', 'config.json');
  const config = JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') });
  writeFileSync(configPath, config);
  const set = await runCli(['config', 'set', 'schema_pack', 'gbrain-creator'], { home });
  expect(set.exitCode).toBe(0);
  expect(set.stderr).not.toContain('Unknown config key');
  const get = await runCli(['config', 'get', 'schema_pack'], { home });
  expect(get.exitCode).toBe(0);
  expect(get.stdout.trim()).toBe('gbrain-creator');
  const active = await runCli(['schema', 'active'], { home, env: { GBRAIN_SCHEMA_PACK: undefined } });
  expect(active.exitCode).toBe(0);
  expect(active.stdout).toContain('Active pack: gbrain-creator');
  expect(readFileSync(configPath, 'utf8')).toBe(config);
});
