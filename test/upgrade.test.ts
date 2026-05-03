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

  test('checks node_modules before source', () => {
    // Order matters: globally-installed copies live in node_modules and must
    // be detected as 'bun' before the source-clone heuristic gets a shot.
    const nodeModulesIdx = source.indexOf('node_modules');
    const sourceIdx = source.indexOf("return 'source'");
    expect(nodeModulesIdx).toBeLessThan(sourceIdx);
  });

  test('checks source before binary', () => {
    // A bun-linked clone has argv[1] ending in /src/cli.ts; a compiled binary
    // has execPath ending in /gbrain. They are distinguishable, but ordering
    // source first keeps the README "Standalone CLI" cohort on the fast path.
    const sourceIdx = source.indexOf("return 'source'");
    const binaryIdx = source.indexOf("endsWith('/gbrain')");
    expect(sourceIdx).toBeLessThan(binaryIdx);
  });

  test('checks binary before clawhub', () => {
    const binaryIdx = source.indexOf("endsWith('/gbrain')");
    const clawhubIdx = source.indexOf("clawhub --version");
    expect(binaryIdx).toBeLessThan(clawhubIdx);
  });

  test('source detection requires both /src/cli.ts entry path and a .git sibling', () => {
    // Defends against false positives — global installs have argv[1] in
    // node_modules (caught earlier), and ad-hoc bun scripts that happen to
    // be named src/cli.ts shouldn't be misdetected without a .git sibling.
    expect(source).toContain(".endsWith('/src/cli.ts')");
    expect(source).toMatch(/existsSync\(join\(repoRoot, '\.git'\)\)/);
  });

  test('source detection resolves argv[1] to absolute path', () => {
    // Without resolve(), invoking `bun src/cli.ts` from inside the clone
    // leaves argv[1] = "src/cli.ts" (relative) and endsWith('/src/cli.ts')
    // returns false. resolve() makes detection robust to cwd.
    expect(source).toContain("resolve(argv1)");
  });

  test('source upgrade runs git pull --ff-only and bun install', () => {
    expect(source).toContain('git -C');
    expect(source).toContain('--ff-only');
    expect(source).toContain('bun install');
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

  test('return type is bun | binary | clawhub | source | unknown', () => {
    expect(source).toContain("'bun' | 'binary' | 'clawhub' | 'source' | 'unknown'");
  });

  test('does not reference npm in case labels or messages', () => {
    // Should not have case 'npm' or 'Upgrading via npm'
    expect(source).not.toContain("case 'npm'");
    expect(source).not.toContain('via npm');
    expect(source).not.toContain('npm upgrade');
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
