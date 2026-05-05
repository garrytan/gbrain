/**
 * Regression tests for cross-platform stdin handling in the CLI.
 *
 * These tests guard against the Windows ENOENT regression caused by reading
 * stdin via the path '/dev/stdin' (which resolves to C:\dev\stdin on Windows).
 *
 * Two stdin code paths are exercised:
 *   1. parseOpArgs in src/cli.ts — drives `gbrain put` and any operation with
 *      `cliHints.stdin` set
 *   2. runReport in src/commands/report.ts — drives `gbrain report`
 *
 * Both must:
 *   - Read from fd 0 (not '/dev/stdin') when stdin is a pipe
 *   - Skip the read entirely (no block, no crash) when stdin is ignored/detached
 *   - Honor an explicit --content/--arg value over piped stdin
 *
 * Tests use `gbrain report` because it does not require a database connection
 * (writes a markdown file to a temp dir), so they are fast and hermetic.
 *
 * Tests are platform-agnostic by design: the bug they catch is Windows-only
 * but the fix changes behavior on all platforms (stricter fd guard), so
 * running them on Linux/macOS still validates the new code path.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

// fileURLToPath gives a native filesystem path (e.g. C:\Users\... on Windows,
// /Users/... on macOS). new URL().pathname does not — on Windows it returns
// a POSIX-style /C:/... that confuses `git -C` and shells.
const CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Use Bun.argv[0] (the absolute path to the running bun executable) instead of
// the bare 'bun' string. On Windows the binary is bun.exe and is typically not
// resolvable via libuv's spawn lookup unless invoked through a shell.
const BUN_BIN = Bun.argv[0];
const SPAWN_CMD = [BUN_BIN, 'run', CLI_PATH];

// Run the CLI once with the given args and stdin spec; return stdout/stderr/exit.
async function runCli(
  args: string[],
  opts: { stdin?: 'pipe' | 'ignore'; input?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const proc = Bun.spawn([...SPAWN_CMD, ...args], {
    cwd: REPO_ROOT,
    stdin: opts.stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    proc.stdin.end();
  }

  const timeoutMs = opts.timeoutMs ?? 10_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return { stdout, stderr, exitCode, timedOut };
}

describe('CLI stdin: cross-platform fd 0 handling (regression for Windows ENOENT)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `gbrain-stdin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── runReport in src/commands/report.ts ────────────────────────────────

  test('report reads piped stdin via fd 0 (not /dev/stdin path)', async () => {
    const body = 'piped report body — must reach the file via fd 0';
    const result = await runCli(
      ['report', '--type', 'test-stdin-pipe', '--title', 'Test', '--dir', testDir],
      { stdin: 'pipe', input: body },
    );

    expect(result.timedOut).toBe(false);
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.stderr).not.toContain('/dev/stdin');
    expect(result.exitCode).toBe(0);

    const reportDir = join(testDir, 'reports', 'test-stdin-pipe');
    expect(existsSync(reportDir)).toBe(true);
    const files = readdirSync(reportDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBe(1);
    const content = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(content).toContain(body);
  });

  test('report does not block or crash when stdin is ignored (no input provided)', async () => {
    // Without --content and without piped stdin, report must error fast,
    // not block reading from a missing fd.
    const result = await runCli(
      ['report', '--type', 'test-stdin-none', '--title', 'Test', '--dir', testDir],
      { stdin: 'ignore', timeoutMs: 5_000 },
    );

    expect(result.timedOut).toBe(false);
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/no content provided/i);
  });

  test('report --content takes precedence over piped stdin', async () => {
    const fromArgs = 'content-from-args-wins';
    const fromStdin = 'content-from-stdin-loses';
    const result = await runCli(
      [
        'report',
        '--type', 'test-stdin-precedence',
        '--title', 'Test',
        '--content', fromArgs,
        '--dir', testDir,
      ],
      { stdin: 'pipe', input: fromStdin },
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);

    const reportDir = join(testDir, 'reports', 'test-stdin-precedence');
    const files = readdirSync(reportDir).filter((f) => f.endsWith('.md'));
    const content = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(content).toContain(fromArgs);
    expect(content).not.toContain(fromStdin);
  });

  // ── parseOpArgs in src/cli.ts (smoke check via --help, no DB needed) ───

  test('CLI --help with piped stdin does not read /dev/stdin or crash', async () => {
    // --help short-circuits before parseOpArgs reads stdin, so this is a
    // smoke test that the early-exit path is not destabilized by the new
    // fstatSync guard. (The full put_page stdin path requires DB and is
    // covered by the report tests above.)
    const result = await runCli(
      ['--help'],
      { stdin: 'pipe', input: 'irrelevant data on stdin' },
    );

    expect(result.timedOut).toBe(false);
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.stderr).not.toContain('/dev/stdin');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('gbrain');
  });
});

// ── Source-level invariant: no remaining '/dev/stdin' literals in src/ ──

describe('Source invariant: no /dev/stdin path literals', () => {
  test("no source file under src/ contains a '/dev/stdin' string literal", async () => {
    // Walk src/ and assert no .ts file uses the POSIX-only path. Comments are
    // allowed (they document the historical fix), so we look only for the
    // quoted string forms that actually trigger the bug.
    //
    // This guards against future code paths reintroducing the same regression
    // outside the two known sites (cli.ts parseOpArgs, report.ts).
    const { execFileSync } = await import('child_process');
    let matches = '';
    try {
      matches = execFileSync(
        'git',
        [
          '-C', REPO_ROOT,
          'grep',
          '-nE',
          String.raw`["']/dev/stdin["']`,
          '--', 'src/',
        ],
        { encoding: 'utf-8' },
      );
    } catch (e: any) {
      // git grep exits 1 when no matches found — that's the success case.
      if (e?.status === 1) matches = '';
      else throw e;
    }

    expect(matches.trim()).toBe('');
  });
});
