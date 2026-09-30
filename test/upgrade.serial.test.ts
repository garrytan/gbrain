import { describe, test, expect, spyOn } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import * as upgradeModule from '../src/commands/upgrade.ts';
import { resolveBunGlobalRoot } from '../src/commands/upgrade.ts';
import { formatMarker } from '../src/core/self-upgrade.ts';
import type { BinarySelfUpdateResult } from '../src/core/binary-self-update.ts';
import { VERSION } from '../src/version.ts';

// Install-method detection runs in-process where it spawns nothing (argv[1] /
// execPath patched); PATH-shimmed paths (clawhub, bun-link, bun update) run
// runUpgrade in a subprocess, because Bun snapshots PATH at process start.

describe('upgrade command', () => {
  test('--help prints usage and exits 0', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'upgrade', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain upgrade');
    expect(stdout).toContain('Detects install method');
    expect(exitCode).toBe(0);
  });

  test('-h also prints usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'upgrade', '-h'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain upgrade');
    expect(exitCode).toBe(0);
  });
});

describe('detectInstallMethod — package-install classification (in-process)', () => {
  // The node_modules branch spawns nothing, so argv[1] / execPath are patched
  // in-process (serial file). The bun-link, clawhub and cwd contracts need
  // PATH shims and live in the subprocess suite below.
  const originalArgv1 = process.argv[1];
  const originalExecPath = process.execPath;

  function detectFrom(pkg: Record<string, unknown>, entry: string, execPath?: string) {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-detect-'));
    const pkgDir = join(root, 'node_modules', 'gbrain');
    const argv1 = join(pkgDir, entry);
    mkdirSync(dirname(argv1), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg));
    writeFileSync(argv1, '');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.argv[1] = argv1;
      if (execPath) Object.defineProperty(process, 'execPath', { value: execPath, configurable: true, writable: true });
      const method = upgradeModule.detectInstallMethod();
      return { method, warnings: warn.mock.calls.map(c => c.join(' ')).join('\n') };
    } finally {
      warn.mockRestore();
      process.argv[1] = originalArgv1;
      Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true, writable: true });
      rmSync(root, { recursive: true, force: true });
    }
  }

  test('canonical by repository.url: bun, no squatter warning', () => {
    const r = detectFrom({ name: 'gbrain', repository: { url: 'git+https://github.com/GarryTan/GBrain.git' } }, 'dist/cli.js');
    expect(r.method).toBe('bun');
    expect(r.warnings).toBe('');
  });

  test('canonical by shipped src/cli.ts marker when repository is absent', () => {
    const r = detectFrom({ name: 'gbrain' }, 'src/cli.ts');
    expect(r.method).toBe('bun');
    expect(r.warnings).toBe('');
  });

  test('npm squatter (no repository, no source) warns with clone + release recovery (#658)', () => {
    const r = detectFrom({ name: 'gbrain', version: '1.3.0' }, 'dist/cli.js');
    expect(r.method).toBe('bun');
    expect(r.warnings).toContain('WARNING');
    expect(r.warnings).toContain('git clone https://github.com/garrytan/gbrain.git');
    expect(r.warnings).toContain('https://github.com/garrytan/gbrain/releases');
    expect(r.warnings).toContain('#658');
  });

  test('node_modules is checked before the compiled-binary execPath name', () => {
    const r = detectFrom({ name: 'gbrain', repository: 'github:garrytan/gbrain' }, 'dist/cli.js', '/opt/bin/gbrain');
    expect(r.method).toBe('bun');
  });
});

describe('resolveBunGlobalRoot', () => {
  const originalBunInstall = process.env.BUN_INSTALL;
  const originalHome = process.env.HOME;
  const originalArgv1 = process.argv[1];

  function restoreEnv() {
    if (originalBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = originalBunInstall;

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    process.argv[1] = originalArgv1;
  }

  test('honors BUN_INSTALL override', () => {
    try {
      process.env.BUN_INSTALL = '/custom/bun';
      process.env.HOME = '/ignored/home';
      expect(resolveBunGlobalRoot()).toBe('/custom/bun/install/global');
    } finally {
      restoreEnv();
    }
  });

  test('uses canonical ~/.bun/install/global when present', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-home-'));
    try {
      delete process.env.BUN_INSTALL;
      process.env.HOME = home;
      const globalRoot = join(home, '.bun', 'install', 'global');
      mkdirSync(join(globalRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(globalRoot, 'package.json'), '{}');

      expect(resolveBunGlobalRoot()).toBe(globalRoot);
    } finally {
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('falls back to the package root above node_modules/gbrain', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-home-'));
    const globalRoot = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-global-'));
    try {
      delete process.env.BUN_INSTALL;
      process.env.HOME = home;
      const cliPath = join(globalRoot, 'node_modules', 'gbrain', 'src', 'cli.ts');
      mkdirSync(dirname(cliPath), { recursive: true });
      mkdirSync(join(globalRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(globalRoot, 'package.json'), '{}');
      writeFileSync(cliPath, '');
      process.argv[1] = cliPath;

      expect(resolveBunGlobalRoot()).toBe(realpathSync(globalRoot));
    } finally {
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(globalRoot, { recursive: true, force: true });
    }
  });
});

describe('post-upgrade behavior (post v0.12.0 merge)', () => {
  // The earlier --execute / --yes / auto_execute tests were removed when the
  // master merge replaced the markdown-driven runPostUpgrade with the TS
  // migration registry + apply-migrations orchestrator. The new contract:
  //   - Prints feature pitches for migrations newer than the prior binary
  //     (via the TS registry, not skills/migrations/*.md).
  //   - Always invokes `apply-migrations --yes` (idempotent; no-op when
  //     nothing is pending).
  //   - --help still prints usage.

  test('--help prints usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'post-upgrade', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: gbrain post-upgrade');
  });
});

describe('assessUpgradeOutcome (#4366)', () => {
  test('mismatch when still running an older version than the target', () => {
    expect(upgradeModule.assessUpgradeOutcome('0.46.25.0', '0.46.21.0')).toBe('mismatch');
  });

  test('ok when the observed version reaches or passes the target', () => {
    expect(upgradeModule.assessUpgradeOutcome('0.46.25.0', '0.46.25.0')).toBe('ok');
    expect(upgradeModule.assessUpgradeOutcome('0.46.25.0', '0.47.0.0')).toBe('ok');
  });

  test('ok when no target is known (legacy callers keep current behavior)', () => {
    expect(upgradeModule.assessUpgradeOutcome(undefined, '0.40.0.0')).toBe('ok');
  });

  test('unverified when the observed version is missing or unparseable', () => {
    expect(upgradeModule.assessUpgradeOutcome('0.46.25.0', '')).toBe('unverified');
    expect(upgradeModule.assessUpgradeOutcome('0.46.25.0', 'not-a-version')).toBe('unverified');
  });

  test('accepts a v-prefixed target tag', () => {
    expect(upgradeModule.assessUpgradeOutcome('v0.46.25.0', '0.46.21.0')).toBe('mismatch');
  });
});

describe('runUpgrade target verification (#4366)', () => {
  const TARGET = '99.99.99.0';
  const OLD = '0.40.0.0';
  const repoRoot = new URL('..', import.meta.url).pathname;

  /**
   * Build a hermetic fake install under a temp HOME and run runUpgrade in a
   * subprocess (Bun snapshots environ at birth, so PATH shims cannot be
   * injected in-process):
   *   - a PATH-first `clawhub` shim exiting 0 without changing anything —
   *     the same successful-no-op shape as `bun update` on an exact-tag Git
   *     pin (the issue's install);
   *   - a PATH-first `gbrain` shim that keeps reporting `observedVersion`;
   *   - a pre-seeded upgrade-available marker so cache retention is observable;
   *   - with `binaryResult`, the driver runs under a copy of bun named `gbrain`
   *     (detectInstallMethod keys on execPath's basename) and the driver mocks
   *     runBinarySelfUpdate to return that result, reaching the binary branch.
   */
  async function runUpgradeAgainstFakeInstall(opts: {
    observedVersion: string;
    targetVersion?: string;
    binaryResult?: BinarySelfUpdateResult;
    /** Body of the PATH `clawhub` shim (default: exit 0 for everything). */
    clawhub?: string;
    /** Driver directory relative to the fake HOME (default: HOME itself). */
    driverDir?: string;
    /** Shim `git` and `bun` as recorders appending `<cwd>|<args>` to HOME/calls.log. */
    recordGitAndBun?: boolean;
    /** Lay out extra install-shape files under HOME before the spawn. */
    setup?: (home: string) => void;
  }): Promise<{ home: string; exitCode: number; stdout: string; stderr: string }> {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-target-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'clawhub'), `#!/bin/sh\n${opts.clawhub ?? 'exit 0'}\n`);
    writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\necho "gbrain ${opts.observedVersion}"\n`);
    chmodSync(join(bin, 'clawhub'), 0o755);
    chmodSync(join(bin, 'gbrain'), 0o755);
    if (opts.recordGitAndBun) {
      for (const tool of ['git', 'bun']) {
        writeFileSync(join(bin, tool), `#!/bin/sh\necho "$(pwd)|$*" >> "${join(home, 'calls.log')}"\nexit 0\n`);
        chmodSync(join(bin, tool), 0o755);
      }
    }

    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'last-update-check'),
      formatMarker({ kind: 'upgrade_available', current: OLD, latest: TARGET }) + '\n',
    );

    // The driver lives OUTSIDE the repo so detectInstallMethod() cannot see a
    // node_modules/.git ancestor and falls through to the clawhub shim.
    const driverDir = join(home, opts.driverDir ?? '');
    mkdirSync(driverDir, { recursive: true });
    opts.setup?.(home);
    const driverPath = join(driverDir, 'driver.ts');
    const mockPrelude = opts.binaryResult
      ? `import { mock } from 'bun:test';\n` +
        `mock.module('${repoRoot}src/core/binary-self-update.ts', () => ({\n` +
        `  runBinarySelfUpdate: async () => (${JSON.stringify(opts.binaryResult)}),\n` +
        `}));\n`
      : '';
    writeFileSync(
      driverPath,
      mockPrelude +
        `import { runUpgrade } from '${repoRoot}src/commands/upgrade.ts';\n` +
        `const t = process.env.TEST_TARGET_VERSION;\n` +
        `await runUpgrade(['--swap-only'], t ? { targetVersion: t } : {});\n`,
    );
    let bunExec = process.execPath;
    if (opts.binaryResult) {
      bunExec = join(home, 'exec', 'gbrain');
      mkdirSync(dirname(bunExec));
      copyFileSync(process.execPath, bunExec);
      chmodSync(bunExec, 0o755);
    }

    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      GBRAIN_HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
    };
    delete env.TEST_TARGET_VERSION;
    delete env.BUN_INSTALL;
    if (opts.targetVersion) env.TEST_TARGET_VERSION = opts.targetVersion;

    const proc = Bun.spawn([bunExec, 'run', driverPath], {
      cwd: repoRoot,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    return { home, exitCode, stdout, stderr };
  }

  test('mismatch exits nonzero, keeps the pending-upgrade cache, and records verify-target', async () => {
    const { home, exitCode, stderr } = await runUpgradeAgainstFakeInstall({
      observedVersion: OLD,
      targetVersion: TARGET,
    });
    try {
      expect(exitCode).toBe(1);
      // The upgrade-available marker must survive so future nags still fire.
      expect(existsSync(join(home, '.gbrain', 'last-update-check'))).toBe(true);
      // No false JUST_UPGRADED breadcrumb for an upgrade that never happened.
      expect(existsSync(join(home, '.gbrain', 'just-upgraded-from'))).toBe(false);
      // The operator gets the exact-tag reinstall remediation.
      expect(stderr).toContain(`github:garrytan/gbrain#v${TARGET}`);

      const errPath = join(home, '.gbrain', 'upgrade-errors.jsonl');
      const records = existsSync(errPath)
        ? readFileSync(errPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
        : [];
      expect(records.some((r) => r.phase === 'verify-target')).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reaching the target keeps the success path: cache cleared, breadcrumb written, exit 0', async () => {
    const { home, exitCode } = await runUpgradeAgainstFakeInstall({
      observedVersion: TARGET,
      targetVersion: TARGET,
    });
    try {
      expect(exitCode).toBe(0);
      expect(existsSync(join(home, '.gbrain', 'last-update-check'))).toBe(false);
      expect(readFileSync(join(home, '.gbrain', 'just-upgraded-from'), 'utf-8').trim()).toBe(VERSION);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('no target (legacy caller) preserves prior behavior even when the version is stale', async () => {
    const { home, exitCode } = await runUpgradeAgainstFakeInstall({
      observedVersion: OLD,
    });
    try {
      expect(exitCode).toBe(0);
      expect(existsSync(join(home, '.gbrain', 'last-update-check'))).toBe(false);
      expect(existsSync(join(home, '.gbrain', 'just-upgraded-from'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // A failed binary swap must still name the release it attempted. With no
  // caller target (plain `gbrain upgrade`), to_version comes from the release
  // tag runBinarySelfUpdate resolved — never '' — so doctor can say which
  // version failed to install.
  for (const [reason, error] of [
    ['smoke_failed', undefined],
    ['version_mismatch', undefined],
    ['replace_failed', 'EACCES: permission denied'],
  ] as const) {
    test(`binary self-update ${reason} records to_version = attempted release`, async () => {
      const { home } = await runUpgradeAgainstFakeInstall({
        observedVersion: OLD,
        binaryResult: { ok: false, reason, targetVersion: TARGET, error },
      });
      try {
        const errPath = join(home, '.gbrain', 'upgrade-errors.jsonl');
        const records = readFileSync(errPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
        const rec = records.find((r) => r.phase === 'binary-self-update');
        expect(rec?.to_version).toBe(TARGET);
        expect(rec?.error).toBe(error ? `${reason}: ${error}` : reason);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  // ── install-method detection + upgrade commands (PATH-shimmed) ──────────

  test('clawhub is detected by running `clawhub --version`, not by PATH presence', async () => {
    // The shim is ON PATH but fails `--version`: a `which clawhub` probe would
    // pick it; the real probe falls through to 'unknown'.
    const { home, stdout, stderr } = await runUpgradeAgainstFakeInstall({
      observedVersion: OLD,
      clawhub: '[ "$1" = "--version" ] && exit 1\nexit 0',
    });
    try {
      expect(stdout).toContain('Detected install method: unknown');
      expect(stderr).toContain('Could not detect installation method.');
      expect(`${stdout}${stderr}`).not.toMatch(/\bnpm\b/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a hung `clawhub --version` probe times out instead of wedging upgrade', async () => {
    const started = Date.now();
    const { home, stdout } = await runUpgradeAgainstFakeInstall({
      observedVersion: OLD,
      clawhub: '[ "$1" = "--version" ] && exec sleep 60\nexit 0',
    });
    try {
      expect(stdout).toContain('Detected install method: unknown');
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('bun-link: case-insensitive .git/config marker; git pull + bun install run at the repo root without a shell', async () => {
    // The checkout path carries shell metacharacters: a template-string
    // execSync would run the `touch`; execFileSync passes it through intact.
    const marker = `INJECTED-${process.pid}-${Date.now()}`;
    const repoDir = `clone $(touch ${marker})`;
    const { home, stdout } = await runUpgradeAgainstFakeInstall({
      observedVersion: OLD,
      driverDir: join(repoDir, 'src'),
      recordGitAndBun: true,
      setup: (h) => {
        mkdirSync(join(h, repoDir, '.git'), { recursive: true });
        writeFileSync(join(h, repoDir, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/GarryTan/GBrain.git\n');
      },
    });
    try {
      const root = join(home, repoDir);
      expect(stdout).toContain('Detected install method: bun-link');
      const calls = readFileSync(join(home, 'calls.log'), 'utf-8').trim().split('\n');
      expect(calls[0]!.split('|')[1]).toBe(`-C ${root} pull --ff-only`);
      expect(calls[1]).toBe(`${realpathSync(root)}|install`);
      for (const dir of [home, repoRoot, join(root, 'src')]) {
        expect(existsSync(join(dir, marker))).toBe(false);
      }
    } finally {
      rmSync(join(repoRoot, marker), { force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('bun global install: `bun update gbrain` runs in the bun global root', async () => {
    const { home, stdout } = await runUpgradeAgainstFakeInstall({
      observedVersion: OLD,
      driverDir: join('global', 'node_modules', 'gbrain', 'src'),
      recordGitAndBun: true,
      setup: (h) => {
        writeFileSync(join(h, 'global', 'package.json'), '{}');
        writeFileSync(join(h, 'global', 'node_modules', 'gbrain', 'package.json'), JSON.stringify({ name: 'gbrain', repository: 'github:garrytan/gbrain' }));
      },
    });
    try {
      expect(stdout).toContain('Detected install method: bun');
      const calls = readFileSync(join(home, 'calls.log'), 'utf-8').trim().split('\n');
      expect(calls).toEqual([`${realpathSync(join(home, 'global'))}|update gbrain`]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
