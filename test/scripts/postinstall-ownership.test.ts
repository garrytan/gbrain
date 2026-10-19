import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { postinstallSkipReason } from '../../scripts/postinstall.ts';

// Protects the Windows global launcher policy that POSIX subprocess tests
// cannot exercise. Rejecting every external realpath breaks regular shims.
// Inject platform/path resolution while inspecting real temporary files;
// the same ownership decision is used by the install hook.
function withLauncher(name: string, check: (fixture: {
  launcher: string;
  home: string;
  pkg: string;
  reason: (platform?: NodeJS.Platform) => string | undefined;
}) => void) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-shim-'));
  const pkg = join(home, 'package');
  const bin = join(home, 'bin');
  const launcher = join(bin, name);
  try {
    mkdirSync(pkg);
    mkdirSync(bin);
    check({
      launcher, home, pkg,
      reason: (platform = 'win32') => postinstallSkipReason(launcher, pkg, {
        platform,
        realpath: path => platform === 'win32' ? win32.normalize(realpathSync(path)) : realpathSync(path),
      }),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('postinstall Windows launcher compatibility', () => {
  test('retains migration invocation for a regular exe with sibling bunx metadata', () => {
    withLauncher('gbrain.exe', ({ launcher, home, reason }) => {
      writeFileSync(launcher, 'launcher fixture');
      writeFileSync(join(home, 'bin', 'gbrain.bunx'), 'metadata fixture');
      expect(reason()).toBeUndefined();
    });
  });

  test('retains migration invocation for a regular cmd shim without bunx metadata', () => {
    withLauncher('gbrain.CMD', ({ launcher, reason }) => {
      writeFileSync(launcher, '@echo off\r\n');
      expect(reason()).toBeUndefined();
    });
  });

  test('rejects an external exe without sibling bunx metadata', () => {
    withLauncher('gbrain.exe', ({ launcher, reason }) => {
      writeFileSync(launcher, 'executable fixture');
      expect(reason()).toBe('gbrain on PATH resolves outside this package');
    });
  });

  test.each(['gbrain.exe', 'gbrain.cmd'])('rejects a foreign symlink named %s even beside metadata', name => {
    withLauncher(name, ({ launcher, home, reason }) => {
      const foreign = join(home, 'foreign');
      writeFileSync(foreign, 'foreign fixture');
      symlinkSync(foreign, launcher, 'file');
      writeFileSync(join(home, 'bin', 'gbrain.bunx'), 'metadata fixture');
      expect(reason()).toBe('gbrain on PATH resolves outside this package');
    });
  });

  test('keeps ownership enforcement on POSIX even for an exe and bunx pair', () => {
    withLauncher('gbrain.exe', ({ launcher, home, reason }) => {
      writeFileSync(launcher, 'launcher fixture');
      writeFileSync(join(home, 'bin', 'gbrain.bunx'), 'metadata fixture');
      expect(reason('linux')).toBe('gbrain on PATH resolves outside this package');
    });
  });

  test('still permits a Windows symlink into the package', () => {
    withLauncher('gbrain.exe', ({ launcher, pkg, reason }) => {
      const owned = join(pkg, 'cli.ts');
      writeFileSync(owned, 'owned fixture');
      symlinkSync(owned, launcher, 'file');
      expect(reason()).toBeUndefined();
    });
  });

  test('returns a skip reason when the launcher cannot be resolved', () => {
    withLauncher('gbrain.exe', ({ reason }) => {
      expect(reason()).toBe('could not resolve gbrain on PATH to this package');
    });
  });
});
