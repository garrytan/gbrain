import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { resolveBunGlobalRoot } from '../src/commands/upgrade.ts';

// We can't easily mock process.execPath in bun, so we test the upgrade
// command's --help output and the detection logic via subprocess

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

describe('detectInstallMethod heuristic (source analysis)', () => {
  // Read the source and verify the detection order is correct
  const { readFileSync } = require('fs');
  const source = readFileSync(
    new URL('../src/commands/upgrade.ts', import.meta.url),
    'utf-8',
  );

  test('checks node_modules before binary', () => {
    const nodeModulesIdx = source.indexOf('node_modules');
    const binaryIdx = source.indexOf("endsWith('/gbrain')");
    expect(nodeModulesIdx).toBeLessThan(binaryIdx);
  });

  test('checks binary before clawhub', () => {
    const binaryIdx = source.indexOf("endsWith('/gbrain')");
    const clawhubIdx = source.indexOf("clawhub --version");
    expect(binaryIdx).toBeLessThan(clawhubIdx);
  });

  test('uses clawhub --version, not which clawhub', () => {
    expect(source).toContain("clawhub --version");
    expect(source).not.toContain('which clawhub');
  });

  test('has timeout on upgrade execSync calls', () => {
    // Count timeout occurrences in execSync calls
    const timeoutMatches = source.match(/timeout:\s*\d+/g) || [];
    expect(timeoutMatches.length).toBeGreaterThanOrEqual(2); // bun + clawhub detection at minimum
  });

  test('return type includes bun-link variant (v0.28.5 cluster D)', () => {
    expect(source).toContain("'bun' | 'bun-link' | 'binary' | 'clawhub' | 'unknown'");
  });

  test('does not reference npm in case labels or messages', () => {
    // Should not have case 'npm' or 'Upgrading via npm'
    expect(source).not.toContain("case 'npm'");
    expect(source).not.toContain('via npm');
    expect(source).not.toContain('npm upgrade');
  });

  // v0.28.5 cluster D: 3-signal layered detection.
  test('bun-link signal walks .git/config for garrytan/gbrain match', () => {
    expect(source).toContain('function detectBunLink');
    expect(source).toContain('GBRAIN_GITHUB_REPO');
    expect(source).toContain('toLowerCase()');
  });

  test('detectBunLink does not gate on isSymbolicLink (bun resolves argv[1])', () => {
    // v0.28.5 gated on lstatSync(argv1).isSymbolicLink() which always
    // returned false because bun resolves symlinks before setting argv[1].
    // The function body between "function detectBunLink" and the next
    // top-level function must not contain isSymbolicLink.
    const fnStart = source.indexOf('function detectBunLink');
    const fnEnd = source.indexOf('\nfunction ', fnStart + 1);
    const fnBody = source.slice(fnStart, fnEnd > -1 ? fnEnd : undefined);
    expect(fnBody).not.toContain('isSymbolicLink');
    expect(fnBody).not.toContain('lstatSync');
  });

  test('detectBunLink returns repoRoot, not a string literal', () => {
    expect(source).toContain("{ repoRoot: string } | null");
    expect(source).toContain('repoRoot: dir');
  });

  test('bun-link upgrade uses execFileSync for shell-injection safety', () => {
    // execFileSync with array args bypasses the shell (same pattern as
    // dry-fix.ts:172). execSync with template strings is vulnerable to
    // paths containing shell metacharacters.
    expect(source).toContain("execFileSync('git', ['-C', linkInfo.repoRoot, 'pull', '--ff-only']");
    expect(source).toContain("execFileSync('bun', ['install']");
  });

  test('bun global upgrade passes cwd to bun update', () => {
    expect(source).toContain('const bunGlobalRoot = resolveBunGlobalRoot()');
    expect(source).toContain("execFileSync('bun', ['update', 'gbrain'], { cwd: bunGlobalRoot");
  });

  test('classifyBunInstall checks repository.url AND src/cli.ts marker', () => {
    // Codex feedback: repository.url alone is spoofable by future squatter
    // updates; the source-marker fallback (src/cli.ts presence) is
    // belt-and-suspenders.
    expect(source).toContain('function classifyBunInstall');
    expect(source).toContain('pkg.repository');
    expect(source).toContain("'src', 'cli.ts'");
  });

  test('squatter recovery message names both source-clone AND release-binary paths', () => {
    expect(source).toContain('printSquatterRecovery');
    expect(source).toContain('git clone');
    expect(source).toContain('releases');
    expect(source).toContain('#658');
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
