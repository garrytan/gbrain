/**
 * #5137 through the real CLI entrypoint: the key-shadow warning prints once
 * per process from ordinary commands, never from `gbrain hook`, carries no
 * key bytes, and `gbrain config unset <key>` (the documented fix for an
 * intended env key) stops it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const ENV_KEY = 'sk-test-ENVKEYexample0123456789abcdefWXYZ';
const CONFIG_KEY = 'sk-test-CONFIGKEYexample9876543210fedcbaQRST';
const home = mkdtempSync(join(tmpdir(), 'gbrain-key-shadow-cli-'));
const configFile = join(home, '.gbrain', 'config.json');
const opts = { home, env: { OPENAI_API_KEY: ENV_KEY } };
const leaked = (text: string) => [ENV_KEY, CONFIG_KEY, ENV_KEY.slice(0, 16), CONFIG_KEY.slice(-12)].filter(fragment => text.includes(fragment));
const warnings = (stderr: string) => stderr.split('\n').filter(line => line.includes('differs from openai_api_key'));

beforeAll(() => {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite'), openai_api_key: CONFIG_KEY }));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

test('an ordinary command warns once on stderr and leaks no key bytes; a hook command never warns', async () => {
  const command = await runCli(['engine'], opts);
  expect(command.exitCode).toBe(0);
  expect(warnings(command.stderr)).toEqual([expect.stringContaining('[gbrain] warning: OPENAI_API_KEY in this process\'s environment differs from openai_api_key')]);
  expect(leaked(command.stdout + command.stderr)).toEqual([]);
  const hook = await runCli(['hook', '--help'], opts);
  expect(warnings(hook.stderr)).toEqual([]);
  expect(leaked(hook.stdout + hook.stderr)).toEqual([]);
}, 120_000);

test('`gbrain config unset openai_api_key` keeps the env key in effect and stops the warning', async () => {
  const unset = await runCli(['config', 'unset', 'openai_api_key'], opts);
  expect(unset.exitCode).toBe(0);
  expect(leaked(unset.stdout + unset.stderr)).toEqual([]);
  expect(JSON.parse(readFileSync(configFile, 'utf8')).openai_api_key).toBeUndefined();
  const after = await runCli(['engine'], opts);
  expect(warnings(after.stderr)).toEqual([]);
}, 120_000);
