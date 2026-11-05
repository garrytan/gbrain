import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');
const TARGET = '99.0.0.0';

type RunOutcome =
  | { kind: 'return'; exitCode: number; bunCalls: string[] }
  | { kind: 'throw'; error: string };

async function runPluginUpgrade(): Promise<RunOutcome> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-8659-'));
  try {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const state = join(home, 'installed-version');
    const calls = join(home, 'bun-calls.log');
    writeFileSync(state, VERSION);
    writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$1" in ls-remote) echo "aaa\trefs/tags/v${TARGET}"; exit 0;; esac
exit 1
`);
    writeFileSync(join(bin, 'bun'), `#!/bin/sh
echo "$*" >> '${calls}'
case "$*" in
  "add -g --backend=copyfile github:garrytan/gbrain#v${TARGET}") echo '${TARGET}' > '${state}';;
esac
exit 0
`);
    writeFileSync(join(bin, 'gbrain'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gbrain $(cat '${state}')"; else exit 0; fi
`);
    for (const tool of ['git', 'bun', 'gbrain']) chmodSync(join(bin, tool), 0o755);

    const globalRoot = join(home, '.bun', 'install', 'global');
    const pkgDir = join(globalRoot, 'node_modules', 'gbrain');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(globalRoot, 'package.json'), JSON.stringify({ dependencies: { gbrain: `github:garrytan/gbrain#v${VERSION}` } }));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gbrain', repository: 'github:garrytan/gbrain' }));
    writeFileSync(join(pkgDir, 'openclaw.plugin.json'), '{}\n');
    const driver = join(pkgDir, 'driver.ts');
    writeFileSync(driver, `import { runUpgrade } from '${REPO}/src/commands/upgrade.ts';
await runUpgrade(['--swap-only', '--no-bun-floor-check']);
`);
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${process.env.PATH}` };
    delete env.BUN_INSTALL;
    const proc = Bun.spawn([process.execPath, 'run', driver], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    const bunCalls = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
    return { kind: 'return', exitCode, bunCalls };
  } catch (error) {
    return { kind: 'throw', error: String(error) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('OpenClaw global upgrade backend', () => {
  test('uses copyfile when reinstalling a package that declares the plugin manifest', async () => {
    const outcome = await runPluginUpgrade();
    expect(outcome.kind).toBe('return');
    expect(outcome.kind === 'return' ? outcome.exitCode : null).toBe(0);
    expect(outcome.kind === 'return' ? outcome.bunCalls : []).toContain(`add -g --backend=copyfile github:garrytan/gbrain#v${TARGET}`);
  }, 60_000);

});
