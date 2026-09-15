import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAgentLauncher } from '../src/core/agent-install/launcher.ts';
import { installHarnessConnection } from '../src/core/harness/install.ts';
import { runCli } from './helpers/cli-spawn.ts';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gbrain-thin-launcher-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

test.each([
  { args: ['search', 'known marker'] },
  { args: ['search', 'known marker', '--source', 'notes'] },
  { args: ['put', 'notes/example', '--content', 'example'] },
])('thin launcher preserves explicit arguments without pinning the grant write source: %j', async ({ args }) => {
  const executable = join(home, 'probe');
  writeFileSync(executable, '#!/usr/bin/env bash\nprintf "%s\\n" "${GBRAIN_BRAIN_ID-unset}" "${GBRAIN_SOURCE-unset}" "$@"\n', { mode: 0o700 });
  const launcher = join(home, 'gbrain');
  writeFileSync(launcher, renderAgentLauncher({ root: home, bunPath: executable, sourceId: 'isolated-write', mode: 'thin-client' }), { mode: 0o700 });
  const child = Bun.spawn(['bash', launcher, ...args], {
    cwd: '/', env: { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SOURCE: 'foreign', GBRAIN_BRAIN_ID: 'foreign' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output.split('\n')).toEqual(['unset', 'unset', ...args, '']);
});

test('installed hosted launcher executes the real CLI without a local brain override', async () => {
  const root = join(home, 'hosted');
  await installHarnessConnection({
    version: 1, mcp_url: 'https://brain.example/mcp', issuer_url: 'https://brain.example',
    client_id: 'fixture-client', client_secret: 'fixture-secret', profile: 'memory-reader',
    harness: 'muse', source_id: 'isolated-write',
  }, { harness: 'muse', root });
  const launcher = join(root, 'bin', 'gbrain');
  const child = Bun.spawn([launcher, '--version'], {
    env: { ...process.env, HOME: home, GBRAIN_HOME: home }, stdout: 'pipe', stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toMatch(/^gbrain \d/);
  const script = readFileSync(launcher, 'utf8');
  expect(script).not.toContain('export GBRAIN_SOURCE=');
  expect(script).not.toContain('--brain host');
  expect(existsSync(join(root, '.gbrain', 'brain.pglite'))).toBe(false);
});

test.each(['postgres', 'pglite'])('call refuses on a %s thin client before connecting a local engine', async engine => {
  mkdirSync(join(home, '.gbrain'));
  const databasePath = join(home, 'unexpected.pglite');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine, database_path: databasePath,
    remote_mcp: { mcp_url: 'https://brain.example/mcp', issuer_url: 'https://brain.example', oauth_client_id: 'fixture', oauth_client_secret: 'fixture-secret' },
  }));
  const result = await runCli(['call', 'list_skills', '{}'], { home, env: { GBRAIN_REMOTE_CLIENT_SECRET: undefined } });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('`gbrain call` is not routable');
  expect(result.stderr).toContain('host');
  expect(result.stderr).not.toContain('No database URL');
  expect(existsSync(databasePath)).toBe(false);
});
