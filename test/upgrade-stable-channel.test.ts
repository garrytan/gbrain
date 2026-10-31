/**
 * GBRA-175 / GBRA-224 W1: the stable release channel, now the default. `gbrain upgrade` on stable installs the release
 * the evidence record names (checked against the `stable` and `v<version>` tags), pinned to its tag, never
 * downgrades except off a version the record withdrew, refuses with a typed code (stable_missing, stable_invalid,
 * stable_unreadable) when stable has no usable release, and then restarts every process onto it. Alpha (`latest` is its
 * alias) keeps the install method's own path.
 *
 * Subprocess: detectInstallMethod keys on argv[1] living under node_modules,
 * and git, bun and gbrain must hit PATH shims, which Bun snapshots at start. The driver stubs fetch with the record.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { parseChannelArg, resolveStableRelease } from '../src/commands/upgrade.ts';
import { channelSwitchCommand, normalizeChannel, parseSelfUpgradeConfigValue, resolveReleaseChannel } from '../src/core/self-upgrade.ts';
import { parseSemver } from '../src/core/semver.ts';
import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');
const v = parseSemver(VERSION)!;
const NEWER = `${v[0]}.${v[1]}.${v[2] + 5}.0`;
const NEWEST = `${v[0]}.${v[1]}.${v[2] + 9}.0`;
const OLDER = `${v[0]}.${v[1]}.${Math.max(0, v[2] - 5)}.0`;
const C_OLDER = '1'.repeat(40);
const C_NEWER = '2'.repeat(40);
const C_NEWEST = '3'.repeat(40);
const COMMIT_OF: Record<string, string> = { [OLDER]: C_OLDER, [NEWER]: C_NEWER, [NEWEST]: C_NEWEST };
const SOAK = 'https://github.com/garrytan/gbrain/actions/runs/123456';

const tags = (stableCommit: string | null, annotated = true) => [
  `${C_OLDER}\trefs/tags/v${OLDER}`, `${C_NEWER}\trefs/tags/v${NEWER}`, `${C_NEWEST}\trefs/tags/v${NEWEST}`, `${C_NEWEST}\trefs/tags/latest-stable`,
  ...(stableCommit ? (annotated ? [`${'9'.repeat(40)}\trefs/tags/stable`, `${stableCommit}\trefs/tags/stable^{}`] : [`${stableCommit}\trefs/tags/stable`]) : []),
].join('\n');
const record = (version: string, over: Record<string, unknown> = {}) => JSON.stringify({ schema: 1, channel: 'stable', version, commit: COMMIT_OF[version], tree: 'f'.repeat(40), soak_run: SOAK, known_bad: [], ...over });
const git = (out: string, status = 0) => () => ({ status, stdout: out });
const serve = (body: string | null, status = 200) => (async () => {
  if (body === null) throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com');
  return new Response(body, { status });
}) as unknown as typeof fetch;

describe('resolveStableRelease (record + tags)', () => {
  test('the record names the release; the stable tag and v<version> must be its commit', async () => {
    expect(await resolveStableRelease({ git: git(tags(C_NEWER)), fetch: serve(record(NEWER)) })).toMatchObject({ ok: true, version: NEWER, commit: C_NEWER });
    expect(await resolveStableRelease({ git: git(tags(C_NEWER, false)), fetch: serve(record(NEWER)) })).toMatchObject({ ok: true, version: NEWER });
  });

  test('missing, invalid and unreadable are distinct typed codes', async () => {
    expect(await resolveStableRelease({ git: git(tags(null)), fetch: serve('Not Found', 404) })).toMatchObject({ ok: false, code: 'stable_missing' });
    expect(await resolveStableRelease({ git: git(tags(null)), fetch: serve(record(NEWER)) })).toMatchObject({ ok: false, code: 'stable_missing' });
    expect(await resolveStableRelease({ git: git(tags(C_NEWER)), fetch: serve('Not Found', 404) })).toMatchObject({ ok: false, code: 'stable_invalid', cause: expect.stringContaining('no published evidence record') });
    expect(await resolveStableRelease({ git: git(tags(C_NEWER)), fetch: serve('{"schema":1,"version":"x"}') })).toMatchObject({ ok: false, code: 'stable_invalid' });
    expect(await resolveStableRelease({ git: git(tags(C_NEWER)), fetch: serve(record(NEWER, { soak_run: undefined })) })).toMatchObject({ ok: false, code: 'stable_invalid', cause: expect.stringContaining('soak_run') });
    expect(await resolveStableRelease({ git: git(tags(C_NEWER)), fetch: serve(record(NEWER, { commit: C_OLDER })) })).toMatchObject({ ok: false, code: 'stable_unreadable', cause: expect.stringContaining('disagree') });
    expect(await resolveStableRelease({ git: git(tags(C_NEWEST)), fetch: serve(record(NEWER, { commit: C_NEWEST })) })).toMatchObject({ ok: false, code: 'stable_invalid', cause: expect.stringContaining(`v${NEWER} is not the stable commit`) });
    expect(await resolveStableRelease({ git: git('', 128), fetch: serve(record(NEWER)) })).toMatchObject({ ok: false, code: 'stable_unreadable' });
    expect(await resolveStableRelease({ git: git(tags(C_NEWER)), fetch: serve(null) })).toMatchObject({ ok: false, code: 'stable_unreadable', cause: expect.stringContaining('ENOTFOUND') });
    expect(await resolveStableRelease({ git: git(tags(C_NEWER)), fetch: serve('oops', 503) })).toMatchObject({ ok: false, code: 'stable_unreadable', cause: expect.stringContaining('HTTP 503') });
  });
});

describe('channel selection', () => {
  test('--channel is read raw in either spelling; a bare flag is an empty value', () => {
    expect(parseChannelArg(['--channel', 'stable'])).toBe('stable');
    expect(parseChannelArg(['--channel=latest'])).toBe('latest');
    expect(parseChannelArg(['--channel', 'beta'])).toBe('beta');
    expect(parseChannelArg(['--channel'])).toBe('');
    expect(parseChannelArg(['--channel', '--json'])).toBe('');
    expect(parseChannelArg(['--json'])).toBeNull();
  });

  test('precedence: --channel, then GBRAIN_RELEASE_CHANNEL, then self_upgrade.channel, then stable', () => {
    const cfg = { self_upgrade: { channel: 'alpha' } };
    expect(resolveReleaseChannel(null, null, undefined)).toEqual({ ok: true, channel: 'stable', source: 'default' });
    expect(resolveReleaseChannel(cfg, null, undefined)).toEqual({ ok: true, channel: 'alpha', source: 'config' });
    expect(resolveReleaseChannel(cfg, null, 'stable')).toEqual({ ok: true, channel: 'stable', source: 'env' });
    expect(resolveReleaseChannel(cfg, 'stable', 'alpha')).toEqual({ ok: true, channel: 'stable', source: 'flag' });
    expect(resolveReleaseChannel(null, null, '')).toEqual({ ok: true, channel: 'stable', source: 'default' });
  });

  test('latest is an alias for alpha in the flag, the env and the config', () => {
    expect(normalizeChannel('latest')).toBe('alpha');
    expect(normalizeChannel(' Alpha ')).toBeNull();
    expect(resolveReleaseChannel(null, 'latest', undefined)).toMatchObject({ ok: true, channel: 'alpha', source: 'flag' });
    expect(resolveReleaseChannel(null, null, 'latest')).toMatchObject({ ok: true, channel: 'alpha', source: 'env' });
    expect(resolveReleaseChannel({ self_upgrade: { channel: 'latest' } }, null, undefined)).toMatchObject({ ok: true, channel: 'alpha', source: 'config' });
    expect(parseSelfUpgradeConfigValue('channel', 'latest')).toEqual({ ok: true, value: 'latest' });
  });

  test('an invalid value is an error at the source that holds it, never a fallthrough, and names the valid values', () => {
    expect(resolveReleaseChannel({ self_upgrade: { channel: 'stable' } }, 'beta', undefined)).toEqual({ ok: false, source: 'flag', raw: 'beta' });
    expect(resolveReleaseChannel({ self_upgrade: { channel: 'stable' } }, null, 'nightly')).toEqual({ ok: false, source: 'env', raw: 'nightly' });
    expect(resolveReleaseChannel({ self_upgrade: { channel: 'bogus' } }, null, undefined)).toEqual({ ok: false, source: 'config', raw: 'bogus' });
    expect(parseSelfUpgradeConfigValue('channel', 'nightly')).toEqual({ ok: false, error: "must be stable or alpha (latest is an alias for alpha) (got 'nightly')" });
  });

  test('the switch command is rendered against what decided the channel', () => {
    expect(channelSwitchCommand('alpha', { ok: true, channel: 'stable', source: 'default' })).toBe('gbrain config set self_upgrade.channel alpha');
    expect(channelSwitchCommand('alpha', { ok: true, channel: 'stable', source: 'config' })).toBe('gbrain config set self_upgrade.channel alpha');
    expect(channelSwitchCommand('alpha', { ok: true, channel: 'stable', source: 'env' })).toStartWith('GBRAIN_RELEASE_CHANNEL=alpha');
    expect(channelSwitchCommand('alpha', { ok: true, channel: 'stable', source: 'flag' })).toBe('gbrain upgrade --channel alpha');
  });
});

interface Run { home: string; exitCode: number; stdout: string; stderr: string; bunCalls: string[]; gbrainCalls: string[] }
interface RunOpts { stableCommit?: string | null; record?: string | null; recordStatus?: number; config?: Record<string, unknown>; env?: Record<string, string>; failAdd?: string; spec?: string; noRepoConfig?: boolean }

async function runStableUpgrade(args: string[], opts: RunOpts = {}): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-stable-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const state = join(home, 'installed-version');
  writeFileSync(state, VERSION);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$1" in ls-remote) cat '${join(home, 'tags.txt')}'; exit 0;; esac\nexit 1\n`);
  writeFileSync(join(home, 'tags.txt'), tags(opts.stableCommit === undefined ? C_NEWER : opts.stableCommit));
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
  const body = opts.record === undefined ? record(NEWER) : opts.record;
  const driver = join(pkgDir, 'driver.ts');
  writeFileSync(driver, [
    `const body = ${JSON.stringify(body)};`,
    `globalThis.fetch = (async (url: unknown) => {`,
    `  if (!String(url).endsWith('/stable-record/stable.json')) return new Response('', { status: 404 });`,
    `  if (body === null) throw new Error('network down');`,
    `  return new Response(body, { status: ${opts.recordStatus ?? 200} });`,
    `}) as typeof fetch;`,
    `const { runUpgrade } = await import('${REPO}/src/commands/upgrade.ts');`,
    `const { currentExitCode, _resetCliExitVerdictForTests } = await import('${REPO}/src/core/cli-force-exit.ts');`,
    `_resetCliExitVerdictForTests();`,
    `await runUpgrade(${JSON.stringify(['--no-bun-floor-check', '--no-autopilot-install', ...args])});`,
    `process.exitCode = currentExitCode();`,
  ].join('\n'));
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${process.env.PATH}`, ...opts.env };
  if (!opts.env?.GBRAIN_RELEASE_CHANNEL) delete env.GBRAIN_RELEASE_CHANNEL;
  delete env.BUN_INSTALL;
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  const proc = Bun.spawn([process.execPath, 'run', driver], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const lines = (f: string) => existsSync(join(home, f)) ? readFileSync(join(home, f), 'utf8').trim().split('\n').filter(Boolean) : [];
  return { home, exitCode: await proc.exited, stdout, stderr, bunCalls: lines('bun-calls.log'), gbrainCalls: lines('gbrain-calls.log') };
}

async function withRun(args: string[], opts: RunOpts, check: (r: Run) => void): Promise<void> {
  const r = await runStableUpgrade(args, opts);
  try { check(r); } finally { rmSync(r.home, { recursive: true, force: true }); }
}

describe('gbrain upgrade on the stable channel', () => {
  test('installs exactly the stable release pinned to its tag (remove, then add), not the newest release', () => withRun(['--channel', 'stable', '--swap-only'], {}, r => {
    expect(r.stdout).toContain(`Stable channel: installing gbrain ${NEWER}`);
    expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${NEWER}`]);
    expect(r.stdout).toContain(`Now running: gbrain ${NEWER}`);
    expect(r.exitCode).toBe(0);
  }));

  test('then the new build restarts every process and the summary says so', () => withRun(['--channel', 'stable'], {}, r => {
    expect(r.gbrainCalls).toContain('upgrade --restart-only');
    expect(r.stdout).toContain(`Restart: every gbrain process on this host runs ${NEWER}`);
    expect(r.exitCode).toBe(0);
  }));

  test('--no-restart installs without restarting and says what to run', () => withRun(['--channel', 'stable', '--no-restart'], {}, r => {
    expect(r.gbrainCalls.some(c => c.includes('--restart-only'))).toBe(false);
    expect(r.stdout).toContain('Restart: skipped (--no-restart)');
  }));

  test('default flip: a home that never set a channel follows stable on a bare upgrade (repo-less config and no config at all)', async () => {
    await withRun(['--swap-only'], {}, r => expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${NEWER}`]));
    await withRun(['--swap-only'], { config: { engine: 'pglite', database_path: '/tmp/gbrain-stable-example.pglite' } }, r => {
      expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${NEWER}`]);
    });
  });

  test('self_upgrade.channel stable and GBRAIN_RELEASE_CHANNEL=stable both select stable over the other sources', async () => {
    await withRun(['--swap-only'], { config: { engine: 'pglite', database_path: '/tmp/gbrain-stable-example.pglite', self_upgrade: { channel: 'stable' } } }, r => {
      expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${NEWER}`]);
    });
    await withRun(['--swap-only'], { config: { engine: 'pglite', database_path: '/tmp/gbrain-stable-example.pglite', self_upgrade: { channel: 'alpha' } }, env: { GBRAIN_RELEASE_CHANNEL: 'stable' } }, r => {
      expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${NEWER}`]);
    });
  });

  test('a build at or above the stable release changes nothing (the stable channel never downgrades)', () => withRun(['--channel', 'stable'], { stableCommit: C_OLDER, record: record(OLDER) }, r => {
    expect(r.stdout).toContain(`is newer than the stable channel's release (${OLDER})`);
    expect(r.bunCalls).toEqual([]);
    expect(r.exitCode).toBe(0);
  }));

  test('known_bad: a build the record withdrew is moved to the current stable, the one move below the running build', () => withRun(['--channel', 'stable', '--swap-only'], { stableCommit: C_OLDER, record: record(OLDER, { known_bad: [VERSION] }) }, r => {
    expect(r.stdout).toContain(`gbrain ${VERSION} was withdrawn from the stable channel`);
    expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${OLDER}`]);
    expect(r.exitCode).toBe(0);
  }));

  test('a failed add restores the release that was installed and records the recovery step', () => withRun(['--channel', 'stable', '--swap-only'], { failAdd: NEWER }, r => {
    expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${NEWER}`, `add -g github:garrytan/gbrain#v${VERSION}`]);
    expect(r.stderr).toContain(`Restored gbrain ${VERSION}.`);
    const rec = JSON.parse(readFileSync(join(r.home, '.gbrain', 'upgrade-errors.jsonl'), 'utf8').trim().split('\n').at(-1)!);
    expect(rec).toMatchObject({ phase: 'stable-reinstall', from_version: VERSION, to_version: NEWER });
    expect(rec.hint).toContain(`#v${NEWER}`);
    expect(r.exitCode).not.toBe(0);
  }));

  test('alpha (and its alias latest): a global install pinned to a commit is replaced with the newest release tag, not left on its pin', async () => {
    for (const channel of ['alpha', 'latest']) {
      await withRun(['--channel', channel, '--swap-only'], { spec: 'github:garrytan/gbrain#0123456789abcdef0123456789abcdef01234567' }, r => {
        expect(r.stdout).toContain('pinned to github:garrytan/gbrain#0123456789abcdef0123456789abcdef01234567');
        expect(r.bunCalls).toEqual(['remove -g gbrain', `add -g github:garrytan/gbrain#v${NEWEST}`]);
        expect(r.bunCalls).not.toContain('update gbrain');
        expect(r.stdout).toContain(`Now running: gbrain ${NEWEST}`);
        expect(r.exitCode).toBe(0);
      });
    }
  });

  test('stable_missing: nothing promoted exits non-zero with the code and the config fix, and installs nothing', () => withRun(['--json'], { stableCommit: null, record: 'Not Found', recordStatus: 404 }, r => {
    const env = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(env).toMatchObject({ code: 'stable_missing' });
    expect(JSON.stringify(env)).toContain('gbrain config set self_upgrade.channel alpha');
    expect(r.bunCalls).toEqual([]);
    expect(r.exitCode).not.toBe(0);
  }));

  test('stable_invalid: a record without its evidence exits non-zero; the fix names the override that chose stable', () => withRun([], { record: record(NEWER, { soak_run: 'https://example.com/x' }), env: { GBRAIN_RELEASE_CHANNEL: 'stable' } }, r => {
    expect(r.stderr).toContain('stable_invalid');
    expect(r.stderr).toContain('soak_run');
    expect(r.stderr).toContain('GBRAIN_RELEASE_CHANNEL=alpha');
    expect(r.bunCalls).toEqual([]);
    expect(r.exitCode).not.toBe(0);
  }));

  test('stable_unreadable: an unreachable record exits non-zero with a retry, never falls back to alpha', () => withRun([], { record: null }, r => {
    expect(r.stderr).toContain('stable_unreadable');
    expect(r.stderr).toContain('Fix: gbrain self-upgrade --check-only --json');
    expect(r.stderr).not.toContain('config set self_upgrade.channel alpha');
    expect(r.bunCalls).toEqual([]);
    expect(r.exitCode).not.toBe(0);
  }));

  test('an invalid channel is a usage error naming the valid values, from the flag or the env', async () => {
    await withRun(['--channel', 'beta'], {}, r => {
      expect(r.stderr).toContain('invalid_params');
      expect(r.stderr).toContain('stable or alpha (latest is an alias for alpha)');
      expect(r.bunCalls).toEqual([]);
      expect(r.exitCode).not.toBe(0);
    });
    await withRun([], { env: { GBRAIN_RELEASE_CHANNEL: 'nightly' } }, r => {
      expect(r.stderr).toContain("GBRAIN_RELEASE_CHANNEL is 'nightly'");
      expect(r.exitCode).not.toBe(0);
    });
  });

  test('--dry-run prints the effective channel, its source and the target, and installs nothing', async () => {
    await withRun(['--dry-run'], {}, r => {
      expect(r.stdout).toContain('Channel: stable (from default)');
      expect(r.stdout).toContain(`Would install gbrain ${NEWER}`);
      expect(r.bunCalls).toEqual([]);
      expect(r.exitCode).toBe(0);
    });
    await withRun(['--dry-run', '--json'], { config: { engine: 'pglite', database_path: '/tmp/gbrain-stable-example.pglite', self_upgrade: { channel: 'latest' } } }, r => {
      expect(JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))).toMatchObject({ dry_run: true, channel: 'alpha', channel_source: 'config', current_version: VERSION });
      expect(r.bunCalls).toEqual([]);
    });
    await withRun(['--dry-run'], { stableCommit: null, record: 'Not Found', recordStatus: 404 }, r => {
      expect(r.stderr).toContain('stable_missing');
      expect(r.exitCode).not.toBe(0);
    });
  });
});
