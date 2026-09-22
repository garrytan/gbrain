/**
 * src/core/serve-service.ts — the persistent `gbrain serve --http` user
 * service behind `gbrain mcp expose`. Everything runs in a tmpdir against a
 * recording fake runner: no launchctl, no systemctl, no process.env writes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner, CommandRunOptions } from '../src/core/tailscale.ts';
import {
  ADMIN_TOKEN_SHAPE, adminTokenPath, detectServiceTarget, ensureAdminToken, installServeService, launchdBootoutFailed, launchdPlistPath,
  readExposeReceipt, receiptPath, refuseSymlink, renderServeLaunchdPlist, renderServeSystemdUnit, renderServeWrapper,
  resolveServeGbrainCommand, serveCommandArgv, serveErrPath, serveLogPath, serveServiceState, SERVE_LAUNCHD_LABEL, SERVE_SYSTEMD_UNIT, systemdUnitPath,
  uninstallServeService, wrapperPath, writeExposeReceipt, type ExposeReceipt,
} from '../src/core/serve-service.ts';

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'gbrain-serve-service-')); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

interface Rule { key: string; status?: number | null; stdout?: string; stderr?: string }
function makeRunner(rules: Rule[] = []): { run: CommandRunner; calls: string[][]; recorded: { argv: string[]; opts: CommandRunOptions | undefined }[] } {
  const calls: string[][] = [];
  const recorded: { argv: string[]; opts: CommandRunOptions | undefined }[] = [];
  const run: CommandRunner = async (argv, opts): Promise<CommandResult> => {
    calls.push(argv);
    recorded.push({ argv, opts });
    const joined = argv.join(' ');
    const rule = rules.find(r => joined.includes(r.key));
    return { status: rule?.status === undefined ? 0 : rule.status, stdout: rule?.stdout ?? '', stderr: rule?.stderr ?? '' };
  };
  return { run, calls, recorded };
}

const TOKEN = 'a'.repeat(64);
/** launchd settle retries pause 1s each; every test that provokes a bootstrap failure injects this so it never waits. */
const noSleep = async (): Promise<void> => {};

describe('paths + target detection', () => {
  test('path helpers hang off the serve dir', () => {
    expect(adminTokenPath('/x/serve')).toBe('/x/serve/admin-token');
    expect(wrapperPath('/x/serve')).toBe('/x/serve/gbrain-serve.sh');
    expect(receiptPath('/x/serve')).toBe('/x/serve/expose.json');
    expect(launchdPlistPath('/home/u')).toBe(`/home/u/Library/LaunchAgents/${SERVE_LAUNCHD_LABEL}.plist`);
    expect(systemdUnitPath('/home/u')).toBe(`/home/u/.config/systemd/user/${SERVE_SYSTEMD_UNIT}`);
  });
  test('detectServiceTarget matrix', () => {
    expect(detectServiceTarget({ platform: 'darwin', executionEnv: 'local' })).toBe('macos');
    expect(detectServiceTarget({ platform: 'darwin', executionEnv: 'cloud-sandbox' })).toBe('macos');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'cloud-sandbox', userBus: { status: 0, stdout: 'running' } })).toBe('none');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'ephemeral-container', userBus: { status: 0, stdout: 'running' } })).toBe('none');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'local', userBus: { status: 0, stdout: 'running\n' } })).toBe('linux-systemd');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'local', userBus: { status: 1, stdout: 'degraded\n' } })).toBe('linux-systemd');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'local', userBus: { status: 1, stdout: 'Failed to connect to bus: No medium found' } })).toBe('none');
    expect(detectServiceTarget({ platform: 'linux', executionEnv: 'local', userBus: null })).toBe('none');
    expect(detectServiceTarget({ platform: 'win32', executionEnv: 'local', userBus: { status: 0, stdout: 'running' } })).toBe('none');
  });
  test('resolveServeGbrainCommand: shim > compiled execPath > bun + cli.ts', () => {
    expect(resolveServeGbrainCommand({ which: () => '/usr/local/bin/gbrain' })).toEqual(['/usr/local/bin/gbrain']);
    expect(resolveServeGbrainCommand({ which: () => null, execPath: '/opt/gbrain/bin/gbrain', argv1: '' })).toEqual(['/opt/gbrain/bin/gbrain']);
    const viaBun = resolveServeGbrainCommand({ which: () => null, execPath: '/home/u/.bun/bin/bun', argv1: '/repo/src/cli.ts', metaUrl: 'file:///repo/src/core/serve-service.ts', fileExists: p => p === '/repo/src/cli.ts' });
    expect(viaBun[0]).toBe('/home/u/.bun/bin/bun');
    expect(viaBun[1]).toBe('/repo/src/cli.ts');
  });
  test('resolveServeGbrainCommand: a compiled binary is [execPath] whatever its basename; dev mode needs cli.ts on disk, else [execPath]', () => {
    const devMeta = 'file:///repo/src/core/serve-service.ts';
    // compiled: bun embeds the sources under /$bunfs/ — the basename is irrelevant (release assets are renamed)
    expect(resolveServeGbrainCommand({ which: () => null, execPath: '/opt/bin/gbrain-darwin-arm64', argv1: '/$bunfs/root/src/cli.ts', metaUrl: 'file:///$bunfs/root/src/core/serve-service.ts', fileExists: () => true }))
      .toEqual(['/opt/bin/gbrain-darwin-arm64']);
    // compiled, older bun shape: argv[1] absent and execPath is not the bun runtime
    expect(resolveServeGbrainCommand({ which: () => null, execPath: '/opt/bin/gbrain-darwin-arm64', argv1: '', metaUrl: devMeta, fileExists: () => true }))
      .toEqual(['/opt/bin/gbrain-darwin-arm64']);
    // dev mode: bun + the cli.ts next to this module's parent, only when it exists
    expect(resolveServeGbrainCommand({ which: () => null, execPath: '/home/u/.bun/bin/bun', argv1: '/repo/src/cli.ts', metaUrl: devMeta, fileExists: p => p === '/repo/src/cli.ts' }))
      .toEqual(['/home/u/.bun/bin/bun', '/repo/src/cli.ts']);
    // cli.ts gone (a packed install without sources) → never bake a path that cannot run
    expect(resolveServeGbrainCommand({ which: () => null, execPath: '/home/u/.bun/bin/bun', argv1: '/repo/src/cli.ts', metaUrl: devMeta, fileExists: () => false }))
      .toEqual(['/home/u/.bun/bin/bun']);
    // the bun runtime itself is never mistaken for a compiled gbrain (bun-profile, bun.exe)
    expect(resolveServeGbrainCommand({ which: () => null, execPath: '/usr/local/bin/bun-profile', argv1: '', metaUrl: devMeta, fileExists: p => p === '/repo/src/cli.ts' }))
      .toEqual(['/usr/local/bin/bun-profile', '/repo/src/cli.ts']);
  });
});

describe('renderServeWrapper', () => {
  const base = { port: 3131, publicUrl: 'https://your-machine.your-tailnet.ts.net', surface: 'full' as const, enableDcr: false, adminTokenPath: '/home/u/.gbrain/serve/admin-token', gbrainEnvFile: '/home/u/.gbrain/env', runtimeDir: '/home/u/.bun/bin' };
  test('reads the token at run time, sources env with set -a, prefixes PATH, cd $HOME, execs serve', () => {
    const w = renderServeWrapper({ ...base, gbrainCommand: ['/usr/local/bin/gbrain'] });
    expect(w.startsWith('#!/bin/bash\n')).toBe(true);
    expect(w).toContain("[ -f ~/.zshenv ] && source ~/.zshenv");
    expect(w).toContain("{ set -a; source '/home/u/.gbrain/env' 2>/dev/null; set +a; }");
    expect(w).toContain(`export PATH='/home/u/.bun/bin':"$HOME/.bun/bin:$PATH"`);
    expect(w).toContain(`GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$(cat '/home/u/.gbrain/serve/admin-token')"`);
    expect(w).toContain('cd "$HOME"');
    expect(w).toContain(`_gbrain='/usr/local/bin/gbrain'`);
    expect(w).toContain('type -P gbrain');
    expect(w).toContain('exec "$_gbrain" serve --http --port 3131 --public-url https://your-machine.your-tailnet.ts.net --surface full');
    expect(w).not.toContain('export GBRAIN_HOME');
    expect(w).not.toContain('--enable-dcr');
  });
  test('bakes GBRAIN_HOME, the bun+cli.ts form, --enable-dcr, and single-quote-escapes hostile paths', () => {
    const w = renderServeWrapper({ ...base, enableDcr: true, surface: 'verbs', gbrainHome: "/home/u/it's home", gbrainCommand: ['/home/u/.bun/bin/bun', "/repo/it's/src/cli.ts"], adminTokenPath: "/home/u/tok'en" });
    expect(w).toContain(`export GBRAIN_HOME='/home/u/it'\\''s home'`);
    expect(w).toContain(`exec "$_gbrain" '/repo/it'\\''s/src/cli.ts' serve --http --port 3131 --public-url https://your-machine.your-tailnet.ts.net --surface verbs --enable-dcr`);
    expect(w).toContain(`cat '/home/u/tok'\\''en'`);
    expect(w).not.toContain(TOKEN);
  });
  test('an empty runtime dir produces no PATH prefix', () => {
    const w = renderServeWrapper({ ...base, runtimeDir: '', gbrainCommand: ['/usr/local/bin/gbrain'] });
    expect(w).toContain(`export PATH="$HOME/.bun/bin:$PATH"`);
  });
  test('serveCommandArgv omits optional flags when unset', () => {
    expect(serveCommandArgv({ port: 4000, publicUrl: 'https://h.ts.net' })).toEqual(['serve', '--http', '--port', '4000', '--public-url', 'https://h.ts.net']);
  });
});

describe('launchd plist + systemd unit renderers', () => {
  test('plist: label, RunAtLoad, KeepAlive, ThrottleInterval 30, log paths, XML escaping', () => {
    const p = renderServeLaunchdPlist({ wrapperPath: '/home/u & co/.gbrain/serve/gbrain-serve.sh', home: '/home/u & co', logPath: '/home/u & co/.gbrain/serve/serve.log', errPath: '/home/u & co/.gbrain/serve/serve.err' });
    expect(p).toContain(`<key>Label</key><string>${SERVE_LAUNCHD_LABEL}</string>`);
    expect(p).toContain('<key>RunAtLoad</key><true/>');
    expect(p).toContain('<key>KeepAlive</key><true/>');
    expect(p).toContain('<key>ThrottleInterval</key><integer>30</integer>');
    expect(p).toContain('<key>WorkingDirectory</key><string>/home/u &amp; co</string>');
    expect(p).toContain('<string>/home/u &amp; co/.gbrain/serve/gbrain-serve.sh</string>');
    expect(p).toContain('<key>StandardErrorPath</key><string>/home/u &amp; co/.gbrain/serve/serve.err</string>');
    expect(p).not.toContain('/home/u & co');
  });
  test('unit: network-online, Restart=always, RestartSec=10, start-limit, append: logs, quoting', () => {
    const u = renderServeSystemdUnit({ wrapperPath: '/home/u/.gbrain/serve/gbrain-serve.sh', logPath: '/home/u/.gbrain/serve/serve.log', errPath: '/home/u/.gbrain/serve/serve.err' });
    expect(u).toContain('After=network-online.target');
    expect(u).toContain('StartLimitIntervalSec=300');
    expect(u).toContain('StartLimitBurst=10');
    expect(u).toContain('ExecStart=/home/u/.gbrain/serve/gbrain-serve.sh');
    expect(u).toContain('Restart=always');
    expect(u).toContain('RestartSec=10');
    expect(u).toContain('StandardOutput=append:/home/u/.gbrain/serve/serve.log');
    expect(u).toContain('StandardError=append:/home/u/.gbrain/serve/serve.err');
    expect(u).toContain('WantedBy=default.target');
    expect(renderServeSystemdUnit({ wrapperPath: '/home/u v/w.sh', logPath: '/l', errPath: '/e' })).toContain('ExecStart="/home/u v/w.sh"');
  });
  test('unit: systemd specifiers are escaped — % → %% in ExecStart and both append: paths, $ → $$ in ExecStart', () => {
    const u = renderServeSystemdUnit({ wrapperPath: '/home/100%user/.gbrain/serve/gbrain-serve.sh', logPath: '/home/100%user/serve.log', errPath: '/home/100%user/$err.log' });
    expect(u).toContain('ExecStart=/home/100%%user/.gbrain/serve/gbrain-serve.sh');
    expect(u).toContain('StandardOutput=append:/home/100%%user/serve.log');
    expect(u).toContain('StandardError=append:/home/100%%user/$err.log');
    expect(renderServeSystemdUnit({ wrapperPath: '/home/u/$HOME-ish/w.sh', logPath: '/l', errPath: '/e' })).toContain('ExecStart=/home/u/$$HOME-ish/w.sh');
    expect(u).not.toContain('100%user');
  });
});

describe('ensureAdminToken', () => {
  test('creates dir 0700 + file 0600 with 64 hex chars; reuses a valid token; regenerates a malformed one', () => {
    const dir = join(temp(), 'serve');
    const path = adminTokenPath(dir);
    const first = ensureAdminToken(path);
    expect(first.action).toBe('created');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const value = readFileSync(path, 'utf-8').trim();
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(ADMIN_TOKEN_SHAPE.test(value)).toBe(true);
    expect(ensureAdminToken(path).action).toBe('reused');
    expect(readFileSync(path, 'utf-8').trim()).toBe(value);
    writeFileSync(path, 'short\n');
    const third = ensureAdminToken(path, { randomHex: () => TOKEN });
    expect(third.action).toBe('regenerated');
    expect(readFileSync(path, 'utf-8').trim()).toBe(TOKEN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  test('a symlink at the token path is refused (never written through)', () => {
    const root = temp();
    const dir = join(root, 'serve');
    mkdirSync(dir, { recursive: true });
    const victim = join(root, 'victim');
    writeFileSync(victim, 'keep me\n');
    const path = adminTokenPath(dir);
    symlinkSync(victim, path);
    expect(() => ensureAdminToken(path, { randomHex: () => TOKEN })).toThrow(/symlink/);
    expect(readFileSync(victim, 'utf-8')).toBe('keep me\n');
    // dangling link too
    const dangling = join(dir, 'dangling');
    symlinkSync(join(root, 'nowhere'), dangling);
    expect(() => refuseSymlink(dangling, 'x')).toThrow(/symlink/);
    expect(() => refuseSymlink(join(dir, 'absent'), 'x')).not.toThrow();
  });
});

describe('install / uninstall / state', () => {
  test('linux-systemd: writes wrapper 0755 + unit 0644, daemon-reload, enable, restart, enable-linger (non-fatal)', async () => {
    const home = temp();
    const dir = join(home, '.gbrain', 'serve');
    const { run, calls } = makeRunner([{ key: 'loginctl enable-linger', status: 1, stderr: 'Could not enable linger' }]);
    const r = await installServeService({ target: 'linux-systemd', wrapperPath: wrapperPath(dir), wrapperContent: '#!/bin/bash\nexit 0\n', home, logPath: join(dir, 'serve.log'), errPath: join(dir, 'serve.err'), run });
    expect(r.error).toBeUndefined();
    expect(r.unit_path).toBe(systemdUnitPath(home));
    expect(statSync(wrapperPath(dir)).mode & 0o777).toBe(0o755);
    expect(statSync(r.unit_path!).mode & 0o777).toBe(0o644);
    expect(readFileSync(r.unit_path!, 'utf-8')).toContain(`ExecStart=${wrapperPath(dir)}`);
    // `restart`, not `enable --now`: a reinstall regenerates the wrapper and the running server must relaunch.
    expect(calls.map(c => c.join(' '))).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable ${SERVE_SYSTEMD_UNIT}`,
      `systemctl --user restart ${SERVE_SYSTEMD_UNIT}`,
      'loginctl enable-linger',
    ]);
    expect(calls.some(c => c.includes('--now'))).toBe(false);
    expect(r.notes.join('\n')).toContain('enable-linger');
    const off = await uninstallServeService({ target: 'linux-systemd', home, run });
    expect(off.removed).toEqual([systemdUnitPath(home)]);
    expect(existsSync(systemdUnitPath(home))).toBe(false);
    expect(calls.slice(4).map(c => c.join(' '))).toEqual([`systemctl --user disable --now ${SERVE_SYSTEMD_UNIT}`, 'systemctl --user daemon-reload']);
  });
  test('linux-systemd: enable failure surfaces as error; restart failure too; linger not attempted', async () => {
    const home = temp();
    const { run, calls } = makeRunner([{ key: 'systemctl --user enable', status: 1, stderr: 'Failed to connect to bus' }]);
    const r = await installServeService({ target: 'linux-systemd', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run });
    expect(r.error).toContain('Failed to connect to bus');
    expect(calls.some(c => c[0] === 'loginctl' || c.includes('restart'))).toBe(false);
    const bad = makeRunner([{ key: 'systemctl --user restart', status: 1, stderr: 'Job for gbrain-serve.service failed' }]);
    const r2 = await installServeService({ target: 'linux-systemd', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: bad.run });
    expect(r2.error).toContain('restart');
    expect(bad.calls.some(c => c[0] === 'loginctl')).toBe(false);
  });
  test('a symlinked wrapper path is refused before anything is written or started', async () => {
    const home = temp();
    const victim = join(home, 'victim.sh');
    writeFileSync(victim, 'original\n');
    const link = join(home, 'w.sh');
    symlinkSync(victim, link);
    const { run, calls } = makeRunner();
    await expect(installServeService({ target: 'linux-systemd', wrapperPath: link, wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run })).rejects.toThrow(/symlink/);
    expect(readFileSync(victim, 'utf-8')).toBe('original\n');
    expect(calls).toEqual([]);
  });
  test('macos: plist 0644, domain-explicit bootout gui/<uid> (ignored) before bootstrap gui/<uid>, bootstrap failure reported', async () => {
    const home = temp();
    const plist = join(home, 'LaunchAgents', 'com.gbrain.serve.plist');
    const { run, calls } = makeRunner([{ key: 'launchctl bootout', status: 3, stderr: 'Boot-out failed: 3: No such process' }]);
    const r = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run, plistPath: plist, uid: 501 });
    expect(r.error).toBeUndefined();
    expect(statSync(plist).mode & 0o777).toBe(0o644);
    expect(calls.map(c => c.join(' '))).toEqual([`launchctl bootout gui/501 ${plist}`, `launchctl bootstrap gui/501 ${plist}`]);
    expect(calls.some(c => c[1] === 'load' || c[1] === 'unload')).toBe(false);
    const bad = makeRunner([{ key: 'launchctl bootstrap', status: 5, stderr: 'Bootstrap failed: 5: Input/output error' }]);
    const r2 = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: bad.run, plistPath: plist, uid: 501, sleep: noSleep });
    expect(r2.error).toBe('launchctl bootstrap failed: Bootstrap failed: 5: Input/output error (after 5 settle retries)');
    expect(bad.calls.some(c => c[1] === 'load')).toBe(false);
    const off = await uninstallServeService({ target: 'macos', home, run, plistPath: plist, uid: 501 });
    expect(off.removed).toEqual([plist]);
    expect(existsSync(plist)).toBe(false);
    expect(calls.slice(2).map(c => c.join(' '))).toEqual([`launchctl bootout gui/501 ${plist}`]);
  });
  test('macos: the uid defaults to the running process; an OLD launchctl that does not know bootstrap/bootout falls back to load/unload (only on that stderr)', async () => {
    const home = temp();
    const plist = join(home, 'LaunchAgents', 'com.gbrain.serve.plist');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const byUid = makeRunner();
    await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: byUid.run, plistPath: plist });
    expect(byUid.calls.map(c => c.join(' '))).toEqual([`launchctl bootout gui/${uid} ${plist}`, `launchctl bootstrap gui/${uid} ${plist}`]);
    // legacy launchctl: both modern verbs are unknown → unload then load, and the load's result decides
    const legacy = makeRunner([
      { key: 'launchctl bootout', status: 1, stderr: 'Unknown command: bootout' },
      { key: 'launchctl bootstrap', status: 1, stderr: 'Unrecognized subcommand: bootstrap' },
    ]);
    const r = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: legacy.run, plistPath: plist, uid: 501 });
    expect(r.error).toBeUndefined();
    expect(legacy.calls.map(c => c.join(' '))).toEqual([
      `launchctl bootout gui/501 ${plist}`, `launchctl unload ${plist}`,
      `launchctl bootstrap gui/501 ${plist}`, `launchctl load ${plist}`,
    ]);
    const legacyBad = makeRunner([
      { key: 'launchctl bootstrap', status: 1, stderr: 'launchctl: unrecognized subcommand' },
      { key: 'launchctl load', status: 5, stderr: 'load failed: 5: Input/output error' },
    ]);
    const r2 = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: legacyBad.run, plistPath: plist, uid: 501, sleep: noSleep });
    expect(r2.error).toBe('launchctl load failed: load failed: 5: Input/output error (after 5 settle retries)');
    // a GENUINE bootstrap failure (or a killed call) never falls back to load
    const genuine = makeRunner([{ key: 'launchctl bootstrap', status: 5, stderr: 'Bootstrap failed: 5: Input/output error' }]);
    await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: genuine.run, plistPath: plist, uid: 501, sleep: noSleep });
    expect(genuine.calls.some(c => c[1] === 'load')).toBe(false);
    const killed = makeRunner([{ key: 'launchctl bootstrap', status: null, stderr: 'Unknown command (timed out)' }]);
    const r3 = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: killed.run, plistPath: plist, uid: 501 });
    expect(killed.calls.some(c => c[1] === 'load')).toBe(false);
    expect(r3.error).toContain('launchctl bootstrap failed');
    // uninstall on legacy launchctl: bootout unknown → unload
    const off = makeRunner([{ key: 'launchctl bootout', status: 1, stderr: 'Unknown command: bootout' }]);
    await uninstallServeService({ target: 'macos', home, run: off.run, plistPath: plist, uid: 501 });
    expect(off.calls.map(c => c.join(' '))).toEqual([`launchctl bootout gui/501 ${plist}`, `launchctl unload ${plist}`]);
  });
  test('macos uninstall: a bootout that fails for a reason other than "not loaded" is a note (the job may still be loaded); the benign not-loaded answers are silent', async () => {
    const home = temp();
    const plist = join(home, 'LaunchAgents', 'com.gbrain.serve.plist');
    mkdirSync(join(home, 'LaunchAgents'), { recursive: true });
    for (const stderr of ['Boot-out failed: 3: No such process', 'Could not find service "com.gbrain.serve" in domain for uid: 501', 'not find service', 'Unload failed: not loaded']) {
      writeFileSync(plist, '<plist/>');
      const benign = makeRunner([{ key: 'launchctl bootout', status: 3, stderr }]);
      const r = await uninstallServeService({ target: 'macos', home, run: benign.run, plistPath: plist, uid: 501 });
      expect(r).toEqual({ removed: [plist], notes: [] });
      expect(launchdBootoutFailed(r)).toBe(false);
    }
    writeFileSync(plist, '<plist/>');
    const bad = makeRunner([{ key: 'launchctl bootout', status: 1, stderr: 'Boot-out failed: 1: Operation not permitted' }]);
    const r = await uninstallServeService({ target: 'macos', home, run: bad.run, plistPath: plist, uid: 501 });
    expect(r.removed).toEqual([plist]);
    expect(r.notes).toEqual(['launchctl bootout failed: Boot-out failed: 1: Operation not permitted']);
    expect(launchdBootoutFailed(r)).toBe(true);
    // killed (status null) is a failure too; a silent failure reports the exit status
    const killed = makeRunner([{ key: 'launchctl bootout', status: null, stderr: '\n(timed out after 60000ms)' }]);
    expect(launchdBootoutFailed(await uninstallServeService({ target: 'macos', home, run: killed.run, plistPath: plist, uid: 501 }))).toBe(true);
    const silent = makeRunner([{ key: 'launchctl bootout', status: 5 }]);
    expect((await uninstallServeService({ target: 'macos', home, run: silent.run, plistPath: plist, uid: 501 })).notes).toEqual(['launchctl bootout failed: exit 5']);
    // the legacy verb is reported under its own name
    const legacy = makeRunner([{ key: 'launchctl bootout', status: 1, stderr: 'Unknown command: bootout' }, { key: 'launchctl unload', status: 1, stderr: 'Unload failed: 1: Operation not permitted' }]);
    const lr = await uninstallServeService({ target: 'macos', home, run: legacy.run, plistPath: plist, uid: 501 });
    expect(lr.notes).toEqual(['launchctl unload failed: Unload failed: 1: Operation not permitted']);
    expect(launchdBootoutFailed(lr)).toBe(true);
    // systemd notes never look like a launchd bootout failure
    expect(launchdBootoutFailed({ removed: [], notes: ['systemctl --user disable --now: exit null'] })).toBe(false);
  });
  test('macos install: a bootstrap that fails while launchd is still unloading the previous job (I/O error / already in progress / 5 / 37) is retried up to 5 times, 1s apart, through the injected sleep', async () => {
    const home = temp();
    const plist = join(home, 'LaunchAgents', 'com.gbrain.serve.plist');
    const settle = (failures: number, stderr: string) => {
      let bootstraps = 0;
      const slept: number[] = [];
      const run: CommandRunner = async (argv) => {
        if (argv[1] === 'bootstrap') { bootstraps++; if (bootstraps <= failures) return { status: 5, stdout: '', stderr }; }
        return { status: 0, stdout: '', stderr: '' };
      };
      return { run, slept, sleep: async (ms: number) => { slept.push(ms); }, bootstraps: () => bootstraps };
    };
    // fails twice, then succeeds: three bootstrap calls, two 1s pauses, no error, a note names the retries
    const twice = settle(2, 'Bootstrap failed: 5: Input/output error');
    const r = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: twice.run, plistPath: plist, uid: 501, sleep: twice.sleep });
    expect(r.error).toBeUndefined();
    expect(twice.bootstraps()).toBe(3);
    expect(twice.slept).toEqual([1000, 1000]);
    expect(r.notes).toEqual(['launchctl bootstrap succeeded after 2 settle retries (launchd was still unloading the previous job)']);
    // "already in progress" (37) is transient too; one retry reads as singular
    const once = settle(1, 'Bootstrap failed: 37: Operation already in progress');
    const r1 = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: once.run, plistPath: plist, uid: 501, sleep: once.sleep });
    expect(r1.error).toBeUndefined();
    expect(r1.notes).toEqual(['launchctl bootstrap succeeded after 1 settle retry (launchd was still unloading the previous job)']);
    // exhausted: 1 + 5 attempts, 5 pauses, then the error names the retries
    const never = settle(Number.POSITIVE_INFINITY, 'Bootstrap failed: 5: Input/output error');
    const r2 = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: never.run, plistPath: plist, uid: 501, sleep: never.sleep });
    expect(r2.error).toBe('launchctl bootstrap failed: Bootstrap failed: 5: Input/output error (after 5 settle retries)');
    expect(never.bootstraps()).toBe(6);
    expect(never.slept).toEqual(Array(5).fill(1000));
    // a failure that is not a settle symptom is never retried
    const other = settle(Number.POSITIVE_INFINITY, 'Bootstrap failed: 125: Domain does not support specified action');
    const r3 = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: other.run, plistPath: plist, uid: 501, sleep: other.sleep });
    expect(r3.error).toBe('launchctl bootstrap failed: Bootstrap failed: 125: Domain does not support specified action');
    expect(other.bootstraps()).toBe(1);
    expect(other.slept).toEqual([]);
  });
  test('target none: only the wrapper is written, no exec', async () => {
    const home = temp();
    const { run, calls } = makeRunner();
    const r = await installServeService({ target: 'none', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run });
    expect(r.plist_path).toBeNull();
    expect(r.unit_path).toBeNull();
    expect(existsSync(join(home, 'w.sh'))).toBe(true);
    expect(calls).toEqual([]);
  });
  test('serveServiceState parses launchctl and systemctl answers', async () => {
    expect(await serveServiceState({ target: 'macos', uid: 501, run: makeRunner([{ key: 'launchctl print', stdout: 'state = running\n' }]).run })).toBe('running');
    expect(await serveServiceState({ target: 'macos', uid: 501, run: makeRunner([{ key: 'launchctl print', stdout: 'state = waiting\n' }]).run })).toBe('loaded');
    expect(await serveServiceState({ target: 'macos', uid: 501, run: makeRunner([{ key: 'launchctl print', status: 113 }]).run })).toBe('not-installed');
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', stdout: 'active\n' }]).run })).toBe('running');
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', status: 3, stdout: 'inactive\n' }]).run })).toBe('stopped');
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', status: 4, stdout: 'inactive\n', stderr: 'Unit gbrain-serve.service could not be found.' }]).run })).toBe('not-installed');
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', status: null }]).run })).toBe('unknown');
    expect(await serveServiceState({ target: 'none', run: makeRunner().run })).toBe('manual');
  });
});

describe('receipt', () => {
  const receipt: ExposeReceipt = {
    version: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', port: 3131,
    public_url: 'https://your-machine.your-tailnet.ts.net', mcp_url: 'https://your-machine.your-tailnet.ts.net/mcp', admin_url: 'https://your-machine.your-tailnet.ts.net/admin',
    mode: 'tailnet', surface: 'full', enable_dcr: false, tailscale: { binary: '/usr/bin/tailscale', dns_name: 'your-machine.your-tailnet.ts.net', tailscale_version: '1.80.0' },
    service: { target: 'linux-systemd', unit_path: '/home/u/.config/systemd/user/gbrain-serve.service', plist_path: null, wrapper_path: '/home/u/.gbrain/serve/gbrain-serve.sh', state: 'running' },
    admin_token_file: '/home/u/.gbrain/serve/admin-token', engine: 'pglite',
  };
  test('round-trips at 0600; malformed or missing → null', () => {
    const path = receiptPath(join(temp(), 'serve'));
    expect(readExposeReceipt(path)).toBeNull();
    writeExposeReceipt(path, receipt);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readExposeReceipt(path)).toEqual(receipt);
    writeFileSync(path, '{"version":2}');
    expect(readExposeReceipt(path)).toBeNull();
    writeFileSync(path, 'nope');
    expect(readExposeReceipt(path)).toBeNull();
  });
  test('a partial receipt (version/port/public_url only, or a wrong mode/target/tailscale/unit-path shape) is treated as absent', () => {
    const path = receiptPath(join(temp(), 'serve'));
    mkdirSync(join(path, '..'), { recursive: true });
    const cases: unknown[] = [
      { version: 1, port: 3131, public_url: 'https://x.ts.net' },
      { version: 1, port: 3131, public_url: 'https://x.ts.net', mode: 'tailnet', service: { state: 'skipped' } },
      { ...receipt, mode: 'public' },
      { ...receipt, service: { ...receipt.service, target: 'windows' } },
      { ...receipt, service: { ...receipt.service, wrapper_path: null } },
      { ...receipt, service: { ...receipt.service, unit_path: 7 } },
      { ...receipt, service: { ...receipt.service, plist_path: undefined } },
      { ...receipt, service: 'linux-systemd' },
      { ...receipt, tailscale: { binary: 7, dns_name: null } },
      { ...receipt, tailscale: null },
      { ...receipt, admin_token_file: undefined },
      { ...receipt, mcp_url: 3 },
      [receipt],
    ];
    for (const c of cases) {
      writeFileSync(path, JSON.stringify(c));
      expect(readExposeReceipt(path)).toBeNull();
    }
    // nulls where the type allows them, and extra/optional fields, are fine
    writeFileSync(path, JSON.stringify({ ...receipt, tailscale: { binary: null, dns_name: null, tailscale_version: null }, service: { ...receipt.service, unit_path: null, state: 'skipped' } }));
    expect(readExposeReceipt(path)?.service.state).toBe('skipped');
  });
  test('a symlinked receipt path is refused on read and write', () => {
    const root = temp();
    const dir = join(root, 'serve');
    mkdirSync(dir, { recursive: true });
    const victim = join(root, 'victim.json');
    writeFileSync(victim, JSON.stringify(receipt));
    const path = receiptPath(dir);
    symlinkSync(victim, path);
    expect(() => readExposeReceipt(path)).toThrow(/symlink/);
    expect(() => writeExposeReceipt(path, { ...receipt, port: 9 })).toThrow(/symlink/);
    expect(JSON.parse(readFileSync(victim, 'utf-8')).port).toBe(3131);
  });
});

describe('ensureAdminToken: exclusive-create race', () => {
  test('a VALID token planted between the existence check and the exclusive open is reused; an INVALID one is replaced', () => {
    const dir = join(temp(), 'serve');
    const path = adminTokenPath(dir);
    const racer = 'b'.repeat(64);
    // randomHex runs before openSync('wx'); a side effect there models a concurrent writer winning the race.
    const r1 = ensureAdminToken(path, { randomHex: () => { writeFileSync(path, `${racer}\n`); return TOKEN; } });
    expect(r1.action).toBe('reused');
    expect(readFileSync(path, 'utf-8').trim()).toBe(racer);
    rmSync(path);
    let calls = 0;
    const r2 = ensureAdminToken(path, { randomHex: () => { calls++; if (calls === 1) writeFileSync(path, 'short\n'); return TOKEN; } });
    expect(r2.action).toBe('regenerated');
    expect(calls).toBe(2);
    expect(readFileSync(path, 'utf-8').trim()).toBe(TOKEN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('the rendered wrapper actually runs under bash', () => {
  // A stand-in for the gbrain CLI: records how the wrapper invoked it.
  const FAKE_GBRAIN = `#!/bin/bash
{
  echo "argv=$*"
  echo "token=$GBRAIN_ADMIN_BOOTSTRAP_TOKEN"
  echo "home=$GBRAIN_HOME"
  echo "fromenv=$FROM_ENV_FILE"
  echo "pwd=$PWD"
} > "$GBRAIN_TEST_RECORD"
exit 0
`;
  function runWrapper(wrapper: string, env: Record<string, string>) {
    // The child gets its OWN env (HOME points at the tmp root); process.env is never touched.
    const proc = Bun.spawnSync(['bash', wrapper], { env, stdout: 'pipe', stderr: 'pipe' });
    return { status: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }
  function scaffold(gbrainCommand: string[], opts: { token?: boolean } = {}) {
    const home = temp();
    const serve = join(home, '.gbrain', 'serve');
    mkdirSync(serve, { recursive: true });
    const tokenPath = join(serve, 'admin-token');
    if (opts.token !== false) writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
    const envFile = join(home, '.gbrain', 'env');
    writeFileSync(envFile, 'FROM_ENV_FILE=hello-from-env\n');
    const wrapper = join(serve, 'gbrain-serve.sh');
    writeFileSync(wrapper, renderServeWrapper({
      port: 3131, publicUrl: 'https://your-machine.your-tailnet.ts.net', surface: 'verbs', enableDcr: true,
      gbrainCommand, adminTokenPath: tokenPath, gbrainEnvFile: envFile, gbrainHome: join(home, 'custom home'), runtimeDir: '',
    }), { mode: 0o755 });
    const record = join(home, 'record.txt');
    return { home, wrapper, record, env: { HOME: home, PATH: '/usr/bin:/bin', GBRAIN_TEST_RECORD: record } };
  }
  test('reads the token at RUN time, exports the env file, bakes GBRAIN_HOME, cd $HOME, execs the baked program + tail + serve argv', () => {
    const bin = join(temp(), 'bin');
    mkdirSync(bin);
    const fake = join(bin, 'bun-stand-in');
    writeFileSync(fake, FAKE_GBRAIN, { mode: 0o755 });
    const s = scaffold([fake, "/repo/it's/src/cli.ts"]);
    const r = runWrapper(s.wrapper, s.env);
    expect(r.status).toBe(0);
    const rec = readFileSync(s.record, 'utf-8');
    expect(rec).toContain("argv=/repo/it's/src/cli.ts serve --http --port 3131 --public-url https://your-machine.your-tailnet.ts.net --surface verbs --enable-dcr");
    expect(rec).toContain(`token=${TOKEN}`);
    expect(rec).toContain(`home=${join(s.home, 'custom home')}`);
    expect(rec).toContain('fromenv=hello-from-env');
    expect(rec).toContain(`pwd=${s.home}`);
    expect(r.stderr).toBe('');
  });
  test('missing token file → exit 1 with the re-run hint and the CLI is never executed; baked CLI gone → PATH fallback, else exit 1', () => {
    const bin = join(temp(), 'bin');
    mkdirSync(bin);
    const fake = join(bin, 'gbrain');
    writeFileSync(fake, FAKE_GBRAIN, { mode: 0o755 });
    const noToken = scaffold([fake], { token: false });
    const r1 = runWrapper(noToken.wrapper, noToken.env);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain('admin token file missing or unreadable');
    expect(r1.stderr).toContain('re-run: gbrain mcp expose');
    expect(existsSync(noToken.record)).toBe(false);
    // baked path is gone, but a `gbrain` sits on PATH → used, with a log line on stdout
    const gone = scaffold(['/nonexistent/gbrain']);
    const r2 = runWrapper(gone.wrapper, { ...gone.env, PATH: `${bin}:/usr/bin:/bin` });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('baked CLI path is gone');
    expect(r2.stdout).toContain(`using ${fake}`);
    expect(readFileSync(gone.record, 'utf-8')).toContain('argv=serve --http --port 3131');
    // baked path gone AND nothing on PATH → exit 1
    const r3 = runWrapper(gone.wrapper, { ...gone.env, GBRAIN_TEST_RECORD: join(gone.home, 'never.txt') });
    expect(r3.status).toBe(1);
    expect(r3.stderr).toContain('gbrain CLI not found');
    expect(existsSync(join(gone.home, 'never.txt'))).toBe(false);
  });
});

describe('install / uninstall / state edges', () => {
  test('daemon-reload failure is a note (install continues); uninstall notes a disable failure, tolerates a missing unit/plist, and target none is a no-op', async () => {
    const home = temp();
    const { run, calls } = makeRunner([{ key: 'daemon-reload', status: 1, stderr: 'Failed to reload daemon' }]);
    const r = await installServeService({ target: 'linux-systemd', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run });
    expect(r.error).toBeUndefined();
    expect(r.notes.some(n => n.includes('daemon-reload') && n.includes('Failed to reload daemon'))).toBe(true);
    expect(calls.some(c => c.includes('restart'))).toBe(true);
    rmSync(systemdUnitPath(home));
    const bad = makeRunner([{ key: 'disable --now', status: 1, stderr: 'Unit gbrain-serve.service not loaded.' }]);
    const off = await uninstallServeService({ target: 'linux-systemd', home, run: bad.run });
    expect(off.removed).toEqual([]);
    expect(off.notes).toHaveLength(1);
    expect(off.notes[0]).toContain('not loaded');
    expect(bad.calls.map(c => c.join(' '))).toEqual([`systemctl --user disable --now ${SERVE_SYSTEMD_UNIT}`, 'systemctl --user daemon-reload']);
    const mac = makeRunner();
    expect(await uninstallServeService({ target: 'macos', home, run: mac.run, plistPath: join(home, 'absent.plist'), uid: 501 })).toEqual({ removed: [], notes: [] });
    expect(mac.calls).toEqual([['launchctl', 'bootout', 'gui/501', join(home, 'absent.plist')]]);
    const none = makeRunner();
    expect(await uninstallServeService({ target: 'none', home, run: none.run })).toEqual({ removed: [], notes: [] });
    expect(none.calls).toEqual([]);
  });
  test('serveServiceState: a killed launchctl → unknown (default uid from the process); systemd activating/reloading → running, failed → stopped, odd words follow the exit status', async () => {
    expect(await serveServiceState({ target: 'macos', uid: 501, run: makeRunner([{ key: 'launchctl print', status: null }]).run })).toBe('unknown');
    const byUid = makeRunner([{ key: 'launchctl print', stdout: 'state = running\n' }]);
    expect(await serveServiceState({ target: 'macos', run: byUid.run })).toBe('running');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    expect(byUid.calls[0]).toEqual(['launchctl', 'print', `gui/${uid}/${SERVE_LAUNCHD_LABEL}`]);
    for (const word of ['activating', 'reloading']) {
      expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', stdout: `${word}\n` }]).run })).toBe('running');
    }
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', status: 3, stdout: 'failed\n' }]).run })).toBe('stopped');
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', status: 4, stdout: 'deactivating\n', stderr: 'no such unit' }]).run })).toBe('not-installed');
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', status: 0, stdout: 'weird\n' }]).run })).toBe('running');
    expect(await serveServiceState({ target: 'linux-systemd', run: makeRunner([{ key: 'is-active', status: 1, stdout: '' }]).run })).toBe('unknown');
  });
  test('resolveServeGbrainCommand honors a compiled argv[1]; runtimeDir "." adds no PATH prefix; log paths hang off the serve dir', () => {
    expect(resolveServeGbrainCommand({ which: () => null, execPath: '/usr/bin/bun', argv1: '/opt/gbrain/bin/gbrain' })).toEqual(['/opt/gbrain/bin/gbrain']);
    const dir = temp();
    const f = join(dir, 'x');
    writeFileSync(f, 'x');
    chmodSync(f, 0o640);
    expect(statSync(f).mode & 0o777).toBe(0o640);
    expect(() => statSync(join(dir, 'absent'))).toThrow();
    const w = renderServeWrapper({ port: 1, publicUrl: 'https://h.ts.net', gbrainCommand: ['/g'], adminTokenPath: '/t', gbrainEnvFile: '/e', runtimeDir: '.' });
    expect(w).toContain('export PATH="$HOME/.bun/bin:$PATH"');
    expect(w).not.toContain("'.':");
    expect(serveLogPath('/x/serve')).toBe('/x/serve/serve.log');
    expect(serveErrPath('/x/serve')).toBe('/x/serve/serve.err');
  });
});

describe('supervisor hardening', () => {
  test('a symlinked plist path is refused before any launchctl call; a symlinked unit path before any systemctl call', async () => {
    const home = temp();
    const victim = join(home, 'victim.txt');
    writeFileSync(victim, 'original\n');
    const plistLink = join(home, 'LaunchAgents', 'com.gbrain.serve.plist');
    mkdirSync(join(home, 'LaunchAgents'), { recursive: true });
    symlinkSync(victim, plistLink);
    const mac = makeRunner();
    await expect(installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: mac.run, plistPath: plistLink })).rejects.toThrow(/symlink/);
    expect(readFileSync(victim, 'utf-8')).toBe('original\n');
    expect(mac.calls).toEqual([]);
    const unitLink = join(home, 'units', 'gbrain-serve.service');
    mkdirSync(join(home, 'units'), { recursive: true });
    symlinkSync(victim, unitLink);
    const linux = makeRunner();
    await expect(installServeService({ target: 'linux-systemd', wrapperPath: join(home, 'w2.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: linux.run, unitPath: unitLink })).rejects.toThrow(/symlink/);
    expect(readFileSync(victim, 'utf-8')).toBe('original\n');
    expect(linux.calls).toEqual([]);
  });
  test('renderServeSystemdUnit quotes a wrapper path carrying a double quote and a backslash exactly', () => {
    const u = renderServeSystemdUnit({ wrapperPath: '/home/u/a"b\\c/w.sh', logPath: '/l', errPath: '/e' });
    expect(u.split('\n')).toContain('ExecStart="/home/u/a\\"b\\\\c/w.sh"');
  });
  test('a silent supervisor failure reports the exit status (null when killed); stdout is used when stderr is empty', async () => {
    const home = temp();
    const plist = join(home, 'LaunchAgents', 'com.gbrain.serve.plist');
    const silent = makeRunner([{ key: 'launchctl bootstrap', status: 5 }]);
    const r = await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: silent.run, plistPath: plist, uid: 501 });
    expect(r.error).toBe('launchctl bootstrap failed: exit 5');
    const killed = makeRunner([{ key: 'systemctl --user enable', status: null }]);
    const r2 = await installServeService({ target: 'linux-systemd', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: killed.run });
    expect(r2.error).toBe(`systemctl --user enable ${SERVE_SYSTEMD_UNIT} failed: exit null`);
    expect(killed.calls.some(c => c.includes('restart') || c[0] === 'loginctl')).toBe(false);
    const viaStdout = makeRunner([{ key: 'systemctl --user restart', status: 1, stdout: '  Job failed. See journalctl  ' }]);
    const r3 = await installServeService({ target: 'linux-systemd', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: viaStdout.run });
    expect(r3.error).toBe(`systemctl --user restart ${SERVE_SYSTEMD_UNIT} failed: Job failed. See journalctl`);
    const reload = makeRunner([{ key: 'daemon-reload', status: null }]);
    const r4 = await installServeService({ target: 'linux-systemd', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: reload.run });
    expect(r4.error).toBeUndefined();
    expect(r4.notes).toContain('systemctl --user daemon-reload: exit null');
    const disable = makeRunner([{ key: 'disable --now', status: null }]);
    const off = await uninstallServeService({ target: 'linux-systemd', home, run: disable.run });
    expect(off.notes).toEqual(['systemctl --user disable --now: exit null']);
  });
  test('every supervisor subprocess carries a timeout: 60s for bootstrap/bootout/enable/restart/disable, 15s for print/daemon-reload/is-active/enable-linger', async () => {
    const home = temp();
    const plist = join(home, 'LaunchAgents', 'com.gbrain.serve.plist');
    const mac = makeRunner();
    await installServeService({ target: 'macos', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: mac.run, plistPath: plist, uid: 501 });
    await uninstallServeService({ target: 'macos', home, run: mac.run, plistPath: plist, uid: 501 });
    await serveServiceState({ target: 'macos', uid: 501, run: mac.run });
    const linux = makeRunner();
    await installServeService({ target: 'linux-systemd', wrapperPath: join(home, 'w.sh'), wrapperContent: '#!/bin/bash\n', home, logPath: '/l', errPath: '/e', run: linux.run });
    await uninstallServeService({ target: 'linux-systemd', home, run: linux.run });
    await serveServiceState({ target: 'linux-systemd', run: linux.run });
    const all = [...mac.recorded, ...linux.recorded];
    expect(all).toHaveLength(3 + 1 + 4 + 2 + 1);
    for (const r of all) expect(r.opts?.timeoutMs).toBeGreaterThan(0);
    const timeouts = Object.fromEntries(all.map(r => [r.argv.join(' '), r.opts?.timeoutMs]));
    expect(timeouts).toEqual({
      [`launchctl bootout gui/501 ${plist}`]: 60_000,
      [`launchctl bootstrap gui/501 ${plist}`]: 60_000,
      'launchctl print gui/501/com.gbrain.serve': 15_000,
      'systemctl --user daemon-reload': 15_000,
      'systemctl --user enable gbrain-serve.service': 60_000,
      'systemctl --user restart gbrain-serve.service': 60_000,
      'loginctl enable-linger': 15_000,
      'systemctl --user disable --now gbrain-serve.service': 60_000,
      'systemctl --user is-active gbrain-serve.service': 15_000,
    });
  });
});
