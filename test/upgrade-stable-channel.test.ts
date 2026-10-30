/**
 * GBRA-175: the stable release channel. `gbrain upgrade --channel stable` (or
 * `self_upgrade.channel stable`) installs the release the `stable` tag names,
 * pinned to its `v<version>` tag, never downgrades, and then restarts every
 * process onto it through the new build's `gbrain upgrade --restart-only`.
 *
 * Subprocess: detectInstallMethod keys on argv[1] living under node_modules,
 * and git, bun and gbrain must hit PATH shims, which Bun snapshots at start.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { parseChannelArg, resolveStableRelease } from '../src/commands/upgrade.ts';
import { normalizeChannel, parseSelfUpgradeConfigValue, resolveReleaseChannel } from '../src/core/self-upgrade.ts';
import { parseSemver } from '../src/core/semver.ts';
import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');
const v = parseSemver(VERSION)!;
const NEWER = `${v[0]}.${v[1]}.${v[2] + 5}.0`;
const NEWEST = `${v[0]}.${v[1]}.${v[2] + 9}.0`;
const OLDER = `${v[0]}.${v[1]}.${Math.max(0, v[2] - 5)}.0`;

const tags = (stableCommit: string | null, annotated = true) => [
  `1111\trefs/tags/v${OLDER}`, `2222\trefs/tags/v${NEWER}`, `3333\trefs/tags/v${NEWEST}`, '3333\trefs/tags/latest-stable',
  ...(stableCommit ? (annotated ? ['9999\trefs/tags/stable', `${stableCommit}\trefs/tags/stable^{}`] : [`${stableCommit}\trefs/tags/stable`]) : []),
].join('\n');

describe('resolveStableRelease', () => {
  const git = (stdout: string, status = 0) => () => ({ status, stdout });
  test('peels the annotated stable tag to the release commit and names its version', () => {
    expect(resolveStableRelease(git(tags('2222')))).toEqual({ version: NEWER, commit: '2222' });
    expect(resolveStableRelease(git(tags('2222', false)))).toEqual({ version: NEWER, commit: '2222' });
  });
  test('the newest v tag wins when several share the stable commit', () => {
    expect(resolveStableRelease(git(`${tags('2222')}\n2222\trefs/tags/v${NEWER.replace(/\.0$/, '.1')}`))).toEqual({ version: NEWER.replace(/\.0$/, '.1'), commit: '2222' });
  });
  test('no stable tag, a stable tag on no release, and an unreadable remote are distinct errors', () => {
    expect(resolveStableRelease(git(tags(null)))).toEqual({ error: 'no_stable' });
    expect(resolveStableRelease(git(tags('abcd')))).toEqual({ error: 'no_release_tag' });
    expect(resolveStableRelease(git('', 128))).toEqual({ error: 'unreadable' });
  });
});

describe('channel selection', () => {
  test('--channel takes latest or stable, in either spelling', () => {
    expect(parseChannelArg(['--channel', 'stable'])).toBe('stable');
    expect(parseChannelArg(['--channel=latest'])).toBe('latest');
    expect(parseChannelArg(['--channel', 'beta'])).toBe('invalid');
    expect(parseChannelArg(['--channel'])).toBe('invalid');
    expect(parseChannelArg(['--swap-only'])).toBeNull();
  });
  test('self_upgrade.channel is validated and defaults to latest', () => {
    expect(parseSelfUpgradeConfigValue('channel', 'stable')).toEqual({ ok: true, value: 'stable' });
    expect(parseSelfUpgradeConfigValue('channel', 'nightly')).toMatchObject({ ok: false });
    expect(resolveReleaseChannel({ self_upgrade: { channel: 'stable' } })).toBe('stable');
    expect(resolveReleaseChannel({ self_upgrade: { channel: 'bogus' } })).toBe('latest');
    expect(resolveReleaseChannel(null)).toBe('latest');
    expect(normalizeChannel('latest')).toBe('latest');
  });
});

interface Run { home: string; exitCode: number; stdout: string; stderr: string; bunCalls: string[]; gbrainCalls: string[] }

async function runStableUpgrade(args: string[], opts: { stableCommit?: string | null; config?: Record<string, unknown>; failAdd?: string; spec?: string } = {}): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-stable-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const state = join(home, 'installed-version');
  writeFileSync(state, VERSION);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$1" in ls-remote) cat '${join(home, 'tags.txt')}'; exit 0;; esac\nexit 1\n`);
  writeFileSync(join(home, 'tags.txt'), tags(opts.stableCommit === undefined ? '2222' : opts.stableCommit));
  // `bun add -g github:garrytan/gbrain#v<x>` installs <x>; `gbrain --version` reports what is installed.
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho "$*" >> '${join(home, 'bun-calls.log')}'\n${opts.failAdd ? `case "$*" in "add -g github:garrytan/gbrain#v${opts.failAdd}") exit 1;; esac\n` : ''}case "$*" in "add -g github:garrytan/gbrain#v"*) echo "$3" | sed 's/.*#v//' > '${state}';; esac\nexit 0\n`);
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gbrain $(cat '${state}')"; exit 0; fi\necho "$*" >> '${join(home, 'gbrain-calls.log')}'\nexit 0\n`);
  for (const f of ['git', 'bun', 'gbrain']) chmodSync(join(bin, f), 0o755);
  if (opts.config) {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(opts.config));
  }
  const globalRoot = join(home, '.bun', 'install', 'global');
  const pkgDir = join(globalRoot, 'node_modules', 'gbrain');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(globalRoot, 'package.json'), JSON.stringify({ dependencies: { gbrain: opts.spec ?? 'github:garrytan/gbrain#latest-stable' } }));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gbrain', repository: 'github:garrytan/gbrain' }));
  const driver = join(pkgDir, 'driver.ts');
  writeFileSync(driver, `import { runUpgrade } from '${REPO}/src/commands/upgrade.ts';\nawait runUpgrade(${JSON.stringify(['--no-bun-floor-check', '--no-autopilot-install', ...args])});\n`);
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.BUN_INSTALL;
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  const proc = Bun.spawn([process.execPath, 'run', driver], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const lines = (f: string) => existsSync(join(home, f)) ? readFileSync(join(home, f), 'utf8').trim().split('\n').filter(Boolean) : [];
  return { home, exitCode: await proc.exited, stdout, stderr, bunCalls: lines('bun-calls.log'), gbrainCalls: lines('gbrain-calls.log') };
}

describe('gbrain upgrade --channel stable', () => {
  test('installs exactly the stable release pinned to its tag (remove, then add), not the newest release', async () => {
    const r = await runStableUpgrade(['--channel', 'stable', '--swap-only']);
    try {
      expect(r.stdout).toContain(`Stable channel: installing gbrain ${NEWER}`);
      expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${NEWER}`]);
      expect(r.stdout).toContain(`Now running: gbrain ${NEWER}`);
      expect(r.exitCode).toBe(0);
    } finally { rmSync(r.home, { recursive: true, force: true }); }
  });

  test('then the new build restarts every process and the summary says so', async () => {
    const r = await runStableUpgrade(['--channel', 'stable']);
    try {
      expect(r.gbrainCalls).toContain('upgrade --restart-only');
      expect(r.stdout).toContain(`Restart: every gbrain process on this host runs ${NEWER}`);
      expect(r.exitCode).toBe(0);
    } finally { rmSync(r.home, { recursive: true, force: true }); }
  });

  test('--no-restart installs without restarting and says what to run', async () => {
    const r = await runStableUpgrade(['--channel', 'stable', '--no-restart']);
    try {
      expect(r.gbrainCalls.some(c => c.includes('--restart-only'))).toBe(false);
      expect(r.stdout).toContain('Restart: skipped (--no-restart)');
    } finally { rmSync(r.home, { recursive: true, force: true }); }
  });

  test('self_upgrade.channel stable makes a bare upgrade follow the stable channel', async () => {
    const r = await runStableUpgrade(['--swap-only'], { config: { engine: 'pglite', database_path: '/tmp/gbrain-stable-example.pglite', self_upgrade: { channel: 'stable' } } });
    try {
      expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${NEWER}`]);
    } finally { rmSync(r.home, { recursive: true, force: true }); }
  });

  test('a build at or above the stable release changes nothing (the stable channel never downgrades)', async () => {
    const same = await runStableUpgrade(['--channel', 'stable'], { stableCommit: '1111' });
    try {
      expect(same.stdout).toContain(`is newer than the stable channel's release (${OLDER})`);
      expect(same.bunCalls).toEqual([]);
      expect(same.exitCode).toBe(0);
    } finally { rmSync(same.home, { recursive: true, force: true }); }
  });

  test('a failed add restores the release that was installed and records the recovery step', async () => {
    const r = await runStableUpgrade(['--channel', 'stable', '--swap-only'], { failAdd: NEWER });
    try {
      expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${NEWER}`, `add -g github:garrytan/gbrain#v${VERSION}`]);
      expect(r.stderr).toContain(`Restored gbrain ${VERSION}.`);
      const record = JSON.parse(readFileSync(join(r.home, '.gbrain', 'upgrade-errors.jsonl'), 'utf8').trim().split('\n').at(-1)!);
      expect(record).toMatchObject({ phase: 'stable-reinstall', from_version: VERSION, to_version: NEWER });
      expect(record.hint).toContain(`#v${NEWER}`);
      expect(r.exitCode).not.toBe(0);
    } finally { rmSync(r.home, { recursive: true, force: true }); }
  });

  test('latest channel: a global install pinned to a commit is replaced (remove, then add the newest release tag), not left on its pin by bun update', async () => {
    const r = await runStableUpgrade(['--swap-only'], { spec: 'github:garrytan/gbrain#0123456789abcdef0123456789abcdef01234567' });
    try {
      expect(r.stdout).toContain('pinned to github:garrytan/gbrain#0123456789abcdef0123456789abcdef01234567');
      expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${NEWEST}`]);
      expect(r.bunCalls).not.toContain('update gbrain');
      expect(r.stdout).toContain(`Now running: gbrain ${NEWEST}`);
      expect(r.exitCode).toBe(0);
    } finally { rmSync(r.home, { recursive: true, force: true }); }
  });

  test('no promoted release refuses with stable_channel_unresolved and changes nothing', async () => {
    const r = await runStableUpgrade(['--channel', 'stable'], { stableCommit: null });
    try {
      expect(r.stderr).toContain('stable_channel_unresolved');
      expect(r.stderr).toContain('No release has been promoted to the stable channel yet');
      expect(r.bunCalls).toEqual([]);
      expect(r.exitCode).not.toBe(0);
    } finally { rmSync(r.home, { recursive: true, force: true }); }
  });
});
