import { describe, test, expect } from 'bun:test';

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
