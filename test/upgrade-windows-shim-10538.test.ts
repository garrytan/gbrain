/**
 * #10538: on Windows, `gbrain upgrade` runs through Bun's ~/.bun/bin/gbrain.exe launcher, which Windows keeps open.
 * `bun remove -g gbrain` deleted the package and gbrain.bunx but left gbrain.exe, so the `bun add -g` that followed
 * failed with `failed to link gbrain: EEXIST`, the restore failed the same way, and gbrain no longer started. The
 * upgrade now moves the orphaned launcher aside (Windows allows renaming a running executable) before each add, a
 * later run deletes the launchers it moved aside, and the restore-failed hint prints one step per line on Windows,
 * with the move-aside step and the restore line.
 *
 * The subprocess tests run the real upgrade with process.platform set to win32 and a fake `bun` on PATH that behaves
 * like Bun on Windows with a held launcher: remove leaves gbrain.exe, and add refuses with EEXIST while it exists.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { bunShimDir, moveAsideOrphanedShim, removeStaleShims } from '../src/core/bun-windows-shim.ts';
import { reinstallHintLines } from '../src/commands/upgrade.ts';
import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');
const TARGET = '99.0.0.0';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `gbrain-10538-${tag}-`)); dirs.push(d); return d; };

describe('#10538 Bun bin directory', () => {
  test('BUN_INSTALL_BIN wins, then BUN_INSTALL/bin, then ~/.bun/bin', () => {
    expect(bunShimDir({ BUN_INSTALL_BIN: '/x/bin', BUN_INSTALL: '/y', HOME: '/h' })).toBe('/x/bin');
    expect(bunShimDir({ BUN_INSTALL: '/y', HOME: '/h' })).toBe(join('/y', 'bin'));
    expect(bunShimDir({ USERPROFILE: '/u', HOME: '/h' })).toBe(join('/u', '.bun', 'bin'));
    expect(bunShimDir({ HOME: '/h' })).toBe(join('/h', '.bun', 'bin'));
  });
});

describe('#10538 moving an orphaned launcher aside', () => {
  test('on win32 it renames gbrain.exe to gbrain.exe.stale.<pid> and touches nothing else', () => {
    const bin = tempDir('move');
    writeFileSync(join(bin, 'gbrain.exe'), 'old launcher');
    writeFileSync(join(bin, 'gbrain.bunx'), 'meta');
    writeFileSync(join(bin, 'other.exe'), 'other');
    writeFileSync(join(bin, 'gbrain.exe.stale-notes.txt'), 'keep');
    expect(moveAsideOrphanedShim(bin, 'win32', 4242)).toEqual({ from: join(bin, 'gbrain.exe'), to: join(bin, 'gbrain.exe.stale.4242') });
    expect(readdirSync(bin).sort()).toEqual(['gbrain.bunx', 'gbrain.exe.stale-notes.txt', 'gbrain.exe.stale.4242', 'other.exe']);
    expect(readFileSync(join(bin, 'gbrain.exe.stale.4242'), 'utf-8')).toBe('old launcher');
  });

  test('a second move in the same run (the restore) picks a free name next to a launcher that is still held', () => {
    const bin = tempDir('twice');
    writeFileSync(join(bin, 'gbrain.exe'), 'partial');
    writeFileSync(join(bin, 'gbrain.exe.stale.7'), 'held');
    const held = join(bin, 'gbrain.exe.stale.7');
    // Linux deletes a held file; model the Windows lock by making the held launcher a directory, which cleanup skips.
    rmSync(held);
    mkdirSync(held);
    expect(moveAsideOrphanedShim(bin, 'win32', 7)?.to).toBe(join(bin, 'gbrain.exe.stale.7.1'));
    expect(existsSync(join(bin, 'gbrain.exe'))).toBe(false);
  });

  test('off Windows, with no launcher, or for something that is not Bun\'s launcher, nothing moves', () => {
    const bin = tempDir('guard');
    expect(moveAsideOrphanedShim(bin, 'win32', 1)).toBeNull();
    writeFileSync(join(bin, 'gbrain.exe'), 'launcher');
    expect(moveAsideOrphanedShim(bin, 'linux', 1)).toBeNull();
    expect(moveAsideOrphanedShim(bin, 'darwin', 1)).toBeNull();
    expect(existsSync(join(bin, 'gbrain.exe'))).toBe(true);
    writeFileSync(join(bin, 'gbrain.exe'), Buffer.alloc(2 * 1024 * 1024));
    expect(moveAsideOrphanedShim(bin, 'win32', 1)).toBeNull();
    expect(existsSync(join(bin, 'gbrain.exe'))).toBe(true);
    rmSync(join(bin, 'gbrain.exe'));
    mkdirSync(join(bin, 'gbrain.exe'));
    expect(moveAsideOrphanedShim(bin, 'win32', 1)).toBeNull();
    rmSync(join(bin, 'gbrain.exe'), { recursive: true });
    const outside = tempDir('outside');
    writeFileSync(join(outside, 'gbrain.exe'), 'a real binary somewhere else');
    symlinkSync(join(outside, 'gbrain.exe'), join(bin, 'gbrain.exe'));
    expect(moveAsideOrphanedShim(bin, 'win32', 1)).toBeNull();
    expect(readFileSync(join(outside, 'gbrain.exe'), 'utf-8')).toBe('a real binary somewhere else');
    expect(existsSync(join(bin, 'gbrain.exe'))).toBe(true);
  });

  test('launchers moved aside earlier are deleted; similarly named files and anything outside the bin dir stay', () => {
    const bin = tempDir('clean');
    for (const name of ['gbrain.exe.stale', 'gbrain.exe.stale.12', 'gbrain.exe.stale.12.3']) writeFileSync(join(bin, name), 'old');
    writeFileSync(join(bin, 'gbrain.exe.stale-notes.txt'), 'keep');
    writeFileSync(join(bin, 'gbrain.exe.staleX'), 'keep');
    mkdirSync(join(bin, 'gbrain.exe.stale.9'));
    const outside = tempDir('clean-outside');
    writeFileSync(join(outside, 'gbrain.exe.stale.1'), 'keep');
    expect(removeStaleShims(bin).sort()).toEqual(['gbrain.exe.stale', 'gbrain.exe.stale.12', 'gbrain.exe.stale.12.3'].map(n => join(bin, n)));
    expect(readdirSync(bin).sort()).toEqual(['gbrain.exe.stale-notes.txt', 'gbrain.exe.stale.9', 'gbrain.exe.staleX']);
    expect(existsSync(join(outside, 'gbrain.exe.stale.1'))).toBe(true);
    expect(removeStaleShims(join(bin, 'missing'))).toEqual([]);
  });
});

describe('#10538 reinstall hint', () => {
  test('Windows prints one step per line, moves a leftover launcher aside before the add, and ends with the restore line', () => {
    const win = reinstallHintLines('0.60.777.0', '0.60.734.0', 'win32', 'C:\\Users\\alice-example\\.bun\\bin');
    const shim = 'C:\\Users\\alice-example\\.bun\\bin\\gbrain.exe';
    expect(win.some(l => l.includes('&&'))).toBe(false);
    expect(win.slice(1)).toEqual([
      'git ls-remote --exit-code --tags https://github.com/garrytan/gbrain refs/tags/v0.60.777.0',
      'bun remove -g gbrain',
      `If ${shim} is still there, move it aside: Move-Item -Force "${shim}" "${shim}.stale"`,
      'bun add -g --backend=copyfile github:garrytan/gbrain#v0.60.777.0',
      'If the add fails, restore 0.60.734.0 with: bun add -g --backend=copyfile github:garrytan/gbrain#v0.60.734.0',
    ]);
  });

  test('POSIX keeps the guarded one-liner and the restore line, with no launcher step', () => {
    const posix = reinstallHintLines('0.60.777.0', '0.60.734.0', 'linux', '/home/a/.bun/bin');
    expect(posix).toHaveLength(2);
    expect(posix.join('\n')).not.toContain('gbrain.exe');
  });
});

/**
 * A pinned Bun global install upgraded on "Windows": the launcher in Bun's bin dir is held open, so the fake
 * `bun remove` leaves gbrain.exe, and the fake `bun add` refuses with EEXIST while it exists. failAdd 'target' makes
 * the target's add write a partial launcher and fail (the restore then meets that launcher); 'all' fails every add.
 */
async function windowsUpgrade(failAdd: 'none' | 'target' | 'all' = 'none') {
  const home = tempDir('upgrade');
  const bunInstall = join(home, '.bun');
  const bin = join(home, 'path-bin');
  const shims = join(bunInstall, 'bin');
  const globalRoot = join(bunInstall, 'install', 'global');
  const pkgDir = join(globalRoot, 'node_modules', 'gbrain');
  mkdirSync(bin);
  mkdirSync(shims, { recursive: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(globalRoot, 'package.json'), JSON.stringify({ dependencies: { gbrain: `github:garrytan/gbrain#v${VERSION}` } }));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gbrain', repository: 'github:garrytan/gbrain' }));
  writeFileSync(join(shims, 'gbrain.exe'), `launcher ${VERSION}\n`);
  writeFileSync(join(shims, 'gbrain.bunx'), 'meta\n');
  writeFileSync(join(shims, 'gbrain.exe.stale.1'), 'left by an earlier upgrade\n');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$*" in *--exit-code*) exit 0;; *) printf 'aaa\\trefs/tags/v${TARGET}\\n'; exit 0;; esac\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'bun'), [
    '#!/bin/sh',
    'G="$BUN_INSTALL/install/global"; B="$BUN_INSTALL/bin"',
    'printf "bun:%s\\n" "$*" >> "$HOME/calls.log"',
    'case "$1" in',
    '  remove) rm -rf "$G/node_modules/gbrain" "$B/gbrain.bunx"; exit 0;;',
    '  add)',
    '    ver="${4##*#v}"',
    '    if [ -e "$B/gbrain.exe" ]; then echo "error: failed to link gbrain: EEXIST" >&2; exit 1; fi',
    `    if [ "${failAdd}" = all ] || { [ "${failAdd}" = target ] && [ "$ver" = "${TARGET}" ]; }; then echo partial > "$B/gbrain.exe"; echo "error: install failed" >&2; exit 1; fi`,
    '    mkdir -p "$G/node_modules/gbrain/src"',
    '    echo \'{"name":"gbrain","repository":"github:garrytan/gbrain"}\' > "$G/node_modules/gbrain/package.json"',
    '    echo "if (process.argv[2] === \'--version\') console.log(\'gbrain $ver\');" > "$G/node_modules/gbrain/src/cli.ts"',
    '    echo "launcher $ver" > "$B/gbrain.exe"; echo meta > "$B/gbrain.bunx"',
    '    echo "{\\"dependencies\\":{\\"gbrain\\":\\"$4\\"}}" > "$G/package.json"',
    '    exit 0;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  const driver = join(pkgDir, 'driver.ts');
  writeFileSync(driver, [
    "Object.defineProperty(process, 'platform', { value: 'win32' });",
    `const { runUpgrade } = await import(${JSON.stringify(join(REPO, 'src/commands/upgrade.ts'))});`,
    `await runUpgrade(['--swap-only', '--no-bun-floor-check'], { targetVersion: '${TARGET}' });`,
    '',
  ].join('\n'));
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home, BUN_INSTALL: bunInstall, PATH: `${bin}:${process.env.PATH}`, GBRAIN_RELEASE_CHANNEL: 'alpha' };
  delete env.BUN_INSTALL_BIN;
  delete env.USERPROFILE;
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'run', driver], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const read = (p: string) => existsSync(p) ? readFileSync(p, 'utf-8') : null;
  return {
    out: stdout + stderr,
    stderr,
    shims,
    calls: read(join(home, 'calls.log')) ?? '',
    launcher: read(join(shims, 'gbrain.exe')),
    shimFiles: readdirSync(shims).sort(),
    errors: (read(join(home, '.gbrain', 'upgrade-errors.jsonl')) ?? '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)),
  };
}

describe('#10538 Windows upgrade with a held gbrain.exe launcher', () => {
  test('the leftover launcher is moved aside after bun remove, so the add links and the upgrade completes', async () => {
    const r = await windowsUpgrade();
    expect(r.out).not.toContain('EEXIST');
    expect(r.calls).toContain(`bun:add -g --backend=copyfile github:garrytan/gbrain#v${TARGET}`);
    expect(r.out).toContain(`Upgrade complete. Now running: gbrain ${TARGET}`);
    expect(r.launcher).toBe(`launcher ${TARGET}\n`);
    expect(r.shimFiles).toEqual(['gbrain.bunx', 'gbrain.exe', expect.stringMatching(/^gbrain\.exe\.stale\.\d+$/)]);
    expect(r.shimFiles).not.toContain('gbrain.exe.stale.1');
    expect(r.errors).toEqual([]);
  }, 60_000);

  test('when the add fails, the partial launcher is moved aside too and the previous version is restored', async () => {
    const r = await windowsUpgrade('target');
    expect(r.stderr).toContain(`Restored gbrain ${VERSION}.`);
    expect(r.stderr).not.toContain('Restore failed');
    expect(r.out).not.toContain('EEXIST');
    expect(r.launcher).toBe(`launcher ${VERSION}\n`);
    expect(r.errors.at(-1)).toMatchObject({ phase: 'pinned-reinstall', to_version: TARGET });
  }, 60_000);

  test('when the restore fails too, the printed and recorded recovery has no && and ends with the restore line', async () => {
    const r = await windowsUpgrade('all');
    const expected = reinstallHintLines(TARGET, VERSION, 'win32', r.shims);
    expect(r.stderr).toContain('Restore failed. Reinstall by hand:');
    const printed = r.stderr.slice(r.stderr.indexOf('Restore failed.')).split('\n').slice(1, 1 + expected.length).map(l => l.trim());
    expect(printed).toEqual(expected);
    expect(printed.some(l => l.includes('&&'))).toBe(false);
    expect(printed.at(-1)).toBe(`If the add fails, restore ${VERSION} with: bun add -g --backend=copyfile github:garrytan/gbrain#v${VERSION}`);
    const hint = r.errors.at(-1)?.hint as string;
    expect(hint).toBe(expected.join('; '));
    expect(hint).not.toContain('&&');
  }, 60_000);
});
