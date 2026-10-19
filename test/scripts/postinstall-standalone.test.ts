import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');

// Protects package ownership at the subprocess boundary: an unrelated PATH
// install must stay untouched, while the global install's own symlink runs.
// Existing coverage only checked a missing binary and upgrade deferral.
// Reverting the ownership check must invoke the foreign fake; no test seam is needed.
function runPostinstall(setup: (pkg: string, bin: string) => void, upgradeOwnsMigrations = false) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-ownership-'));
  const pkg = join(home, '.bun', 'install', 'global', 'node_modules', 'gbrain');
  const bin = join(home, '.bun', 'bin');
  try {
    mkdirSync(join(pkg, 'scripts'), { recursive: true });
    mkdirSync(bin);
    copyFileSync(join(REPO, 'scripts', 'postinstall.ts'), join(pkg, 'scripts', 'postinstall.ts'));
    symlinkSync(process.execPath, join(bin, 'bun'), 'file');
    writeFileSync(join(home, 'calls.json'), '[]');
    setup(pkg, bin);
    const result = spawnSync(process.execPath, ['--no-env-file', join(pkg, 'scripts', 'postinstall.ts')], {
      cwd: home,
      env: {
        HOME: home, GBRAIN_HOME: home, PATH: bin,
        ...(upgradeOwnsMigrations ? { GBRAIN_UPGRADE_OWNS_MIGRATIONS: '1' } : {}),
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { ...result, calls: JSON.parse(readFileSync(join(home, 'calls.json'), 'utf8')) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function fakeGbrain(path: string, exitCode = 0) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.GBRAIN_HOME, 'calls.json'), JSON.stringify(process.argv.slice(2)));
process.exit(${exitCode});
`, { mode: 0o755 });
}

describe('scripts/postinstall.ts exits 0 on every path', () => {
  test('runs from a directory holding only package.json and the script (Docker dependency layer)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-standalone-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      copyFileSync(join(REPO, 'package.json'), join(dir, 'package.json'));
      copyFileSync(join(REPO, 'scripts', 'postinstall.ts'), join(dir, 'scripts', 'postinstall.ts'));
      const result = spawnSync(process.execPath, ['--no-env-file', join(dir, 'scripts', 'postinstall.ts')], {
        cwd: dir,
        env: { HOME: dir, GBRAIN_HOME: dir, PATH: dir },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stderr).toContain('postinstall skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not invoke an unrelated binary on PATH and names the manual migration command', () => {
    const result = runPostinstall((_pkg, bin) => fakeGbrain(join(bin, 'gbrain')));
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('outside this package');
    expect(result.stderr).toContain('gbrain apply-migrations --yes');
  });

  test('follows the global launcher symlink into this package and runs migrations', () => {
    const result = runPostinstall((pkg, bin) => {
      const cli = join(pkg, 'src', 'cli.ts');
      fakeGbrain(cli);
      symlinkSync(cli, join(bin, 'gbrain'), 'file');
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.calls).toEqual(['apply-migrations', '--yes', '--non-interactive']);
    expect(result.stderr).toBe('');
  });

  test('does not treat a sibling with the same path prefix as part of this package', () => {
    const result = runPostinstall((pkg, bin) => {
      const cli = join(`${pkg}-other`, 'src', 'cli.ts');
      fakeGbrain(cli);
      symlinkSync(cli, join(bin, 'gbrain'), 'file');
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain('outside this package');
  });

  test('does not invoke an in-package symlink whose target is outside the package', () => {
    const result = runPostinstall((pkg, bin) => {
      const foreign = join(bin, 'foreign.ts');
      fakeGbrain(foreign);
      mkdirSync(join(pkg, 'src'));
      const cli = join(pkg, 'src', 'cli.ts');
      symlinkSync(foreign, cli, 'file');
      symlinkSync(cli, join(bin, 'gbrain'), 'file');
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain('outside this package');
  });

  test('still defers an owned binary to post-upgrade when upgrade owns migrations', () => {
    const result = runPostinstall((pkg, bin) => {
      const cli = join(pkg, 'src', 'cli.ts');
      fakeGbrain(cli);
      symlinkSync(cli, join(bin, 'gbrain'), 'file');
    }, true);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain('migrations deferred to `gbrain post-upgrade`');
  });

  test('does not abort the install when the owned migration command fails', () => {
    const result = runPostinstall((pkg, bin) => {
      const cli = join(pkg, 'src', 'cli.ts');
      fakeGbrain(cli, 7);
      symlinkSync(cli, join(bin, 'gbrain'), 'file');
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.calls).toEqual(['apply-migrations', '--yes', '--non-interactive']);
    expect(result.stderr).toContain('gbrain apply-migrations --yes');
  });
});
