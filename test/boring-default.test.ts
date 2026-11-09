/**
 * GBRA-224 W5: the default install adds nothing. A fresh `gbrain setup
 * claude-code`, `gbrain setup codex` or `gbrain init --pglite --no-embedding`
 * (keyless, PGLite, no repo) starts no process that outlives it, calls no
 * service manager, writes no systemd unit, launchd plist, crontab entry or
 * autopilot start script, connects no connector, and leaves self-upgrade in
 * notify mode. An upgrade (`gbrain post-upgrade` without the opt-out, the
 * path `gbrain upgrade` takes) on a brain that never had autopilot installs
 * none, repo-less or with a repo; it only rewrites a unit that is already
 * installed. Postgres brains (where Phase F can install) are covered in
 * apply-migrations-safety.serial.test.ts, with the postinstall argv.
 *
 * systemctl, launchctl and crontab are PATH shims that log every call, so a
 * daemon install or a crontab write shows up even where the real tool is
 * missing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; bin: string; launcher: string; log: string }

function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-boring-default-'));
  roots.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  const log = join(root, 'supervisor-calls.log');
  for (const tool of ['systemctl', 'launchctl', 'crontab']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${log}'\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const launcher = join(bin, 'gbrain');
  writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(launcher, 0o755);
  return { root, home, bin, launcher, log };
}

const CLEAN = {
  CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined,
  GBRAIN_NO_AUTOPILOT_INSTALL: undefined, GBRAIN_RELEASE_CHANNEL: undefined,
};

function gbrain(b: Box, args: string[]): Promise<CliResult> {
  return runCli(args, { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home, PATH: `${b.bin}:${process.env.PATH ?? ''}` }, timeoutMs: 180_000 });
}

function liveProcesses(b: Box): string[] {
  const ps = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return ps.split('\n').filter(line => line.includes(b.root) && !line.includes('ps -eo'));
}

async function expectNothingAdded(b: Box): Promise<void> {
  expect(existsSync(b.log) ? readFileSync(b.log, 'utf8') : '').toBe('');
  for (const dir of ['.config/systemd', 'Library/LaunchAgents']) expect(existsSync(join(b.home, dir))).toBe(false);
  expect(readdirSync(join(b.home, '.gbrain')).filter(name => /autopilot|start-.*\.sh$/.test(name))).toEqual([]);
  expect(liveProcesses(b)).toEqual([]);
  const config = JSON.parse(readFileSync(join(b.home, '.gbrain', 'config.json'), 'utf8'));
  expect(config.self_upgrade.mode).toBe('notify');
  expect(config.self_upgrade.channel).toBeUndefined();
  const status = await gbrain(b, ['connectors', 'status', '--json']);
  expect(status.exitCode, status.stderr).toBe(0);
  const providers = JSON.parse(status.stdout).providers as Array<{ provider: string; auto_sync: boolean; credential_present: boolean }>;
  expect(providers.length).toBeGreaterThan(0);
  expect(providers.filter(p => p.auto_sync || p.credential_present)).toEqual([]);
}

describe('the default install adds nothing (GBRA-224 W5)', () => {
  for (const harness of ['claude-code', 'codex'] as const) {
    test(`fresh \`gbrain setup ${harness}\` on a repo-less keyless brain starts and installs nothing`, async () => {
      const b = box();
      const r = await runCli(['setup', harness, '--gbrain-bin', b.launcher, '--json'],
        { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home, PATH: `${b.bin}:${process.env.PATH ?? ''}` }, timeoutMs: 180_000 });
      expect(r.exitCode, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).target.brain.kind).toBe('new-local-pglite');
      await expectNothingAdded(b);
    }, 240_000);
  }

  test('`gbrain init --pglite --no-embedding` starts and installs nothing', async () => {
    const b = box();
    const r = await gbrain(b, ['init', '--pglite', '--no-embedding', '--json']);
    expect(r.exitCode, r.stderr).toBe(0);
    await expectNothingAdded(b);
  }, 240_000);
});

test('INSTALL_FOR_AGENTS.md lists every opt-in in one section, under the anchor setup prints', () => {
  const doc = readFileSync(resolve(import.meta.dir, '..', 'INSTALL_FOR_AGENTS.md'), 'utf8');
  expect(doc.match(/^## Opt-ins$/gm)).toHaveLength(1);
  const section = doc.split(/^## Opt-ins$/m)[1]!.split(/^## /m)[0]!;
  for (const command of ['--embedding-model', 'gbrain autopilot --install', ' dream`', 'gbrain connectors auth', 'self_upgrade.mode auto', 'self_upgrade.channel']) {
    expect(section).toContain(command);
  }
});

describe('an upgrade on a brain that never had autopilot installs none (GBRA-224 W5)', () => {
  for (const shape of ['repo-less', 'repo'] as const) {
    test(`post-upgrade without the opt-out on a ${shape} brain runs v0.11.0 and adds nothing`, async () => {
      const b = box();
      expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
      if (shape === 'repo') {
        const repo = join(b.root, 'brain-repo');
        mkdirSync(repo);
        execFileSync('git', ['init', '-q', repo]);
        const set = await gbrain(b, ['config', 'set', 'sync.repo_path', repo]);
        expect(set.exitCode, set.stderr).toBe(0);
      }
      const r = await gbrain(b, ['post-upgrade']);
      expect(r.exitCode, r.stderr + r.stdout).toBe(0);
      const ledger = readFileSync(join(b.home, '.gbrain', 'migrations', 'completed.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(ledger.filter(e => e.version === '0.11.0').at(-1)).toMatchObject({ status: 'complete', autopilot_installed: false });
      await expectNothingAdded(b);
    }, 300_000);
  }

  test.if(process.platform === 'linux')('post-upgrade rewrites only an autopilot unit that is already installed', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const unitDir = join(b.home, '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    const unit = join(unitDir, 'gbrain-autopilot.service');
    writeFileSync(unit, `[Unit]\nDescription=GBrain Autopilot\n[Service]\nExecStart=${join(b.home, '.gbrain', 'autopilot-run.sh')}\nRestart=on-failure\nStandardOutput=append:%h/.gbrain/autopilot.log\n`);
    const r = await gbrain(b, ['post-upgrade']);
    expect(r.exitCode, r.stderr + r.stdout).toBe(0);
    expect(readFileSync(unit, 'utf8')).toContain('Restart=always');
    expect(readdirSync(unitDir)).toEqual(['gbrain-autopilot.service']);
    expect(existsSync(join(b.home, 'Library', 'LaunchAgents'))).toBe(false);
  }, 300_000);
});
