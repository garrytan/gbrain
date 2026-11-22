/**
 * #9665: a host that restores the thin-client tree without its node_modules got a launcher that passed its runtime
 * guard and then died in Bun's module resolver ("Cannot find package 'js-yaml'"). The launcher now checks the tree's
 * dependencies and names the lockfile restore. Reported by @Kkkkkuro.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAgentLauncher } from '../src/core/agent-install/launcher.ts';
import { installHarnessConnection } from '../src/core/harness/install.ts';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gbrain-thin-deps-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

async function run(launcher: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['bash', launcher, 'whoami'], { cwd: '/', env: { ...process.env, HOME: home, GBRAIN_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, stdout, stderr };
}

test('a thin tree restored without node_modules fails with the lockfile restore command, then runs once restored', async () => {
  const tree = join(home, 'gbrain-thin-example');
  mkdirSync(join(tree, 'src'), { recursive: true });
  writeFileSync(join(tree, 'bun.lock'), '');
  writeFileSync(join(tree, 'src', 'cli.ts'), '');
  const bun = join(home, 'bun');
  writeFileSync(bun, '#!/usr/bin/env bash\nprintf "ran %s\\n" "$*"\n', { mode: 0o700 });
  const launcher = join(home, 'gbrain');
  writeFileSync(launcher, renderAgentLauncher({ root: home, bunPath: bun, cliPath: join(tree, 'src', 'cli.ts'), mode: 'thin-client', dependencies: tree }), { mode: 0o700 });

  const missing = await run(launcher);
  expect(missing.code).toBe(1);
  expect(missing.stdout).toBe('');
  expect(missing.stderr).toContain(`GBrain dependencies are missing from ${tree}/node_modules`);
  expect(missing.stderr).toContain(`cd ${tree} && ${bun} install --frozen-lockfile --ignore-scripts`);

  mkdirSync(join(tree, 'node_modules'));
  const restored = await run(launcher);
  expect(restored.code).toBe(0);
  expect(restored.stdout).toContain('whoami');
});

test('gbrain connect --install writes a launcher that checks its source tree\'s dependencies', async () => {
  const root = join(home, 'hosted');
  await installHarnessConnection({
    version: 1, mcp_url: 'https://brain.example/mcp', issuer_url: 'https://brain.example',
    client_id: 'fixture-client', client_secret: 'fixture-secret', profile: 'memory-reader',
    harness: 'muse', source_id: 'isolated-write',
  }, { harness: 'muse', root });
  const tree = dirname(dirname(fileURLToPath(new URL('../src/cli.ts', import.meta.url))));
  expect(readFileSync(join(root, 'bin', 'gbrain'), 'utf8')).toContain(`if [[ ! -d ${tree}/node_modules ]]; then`);
});
