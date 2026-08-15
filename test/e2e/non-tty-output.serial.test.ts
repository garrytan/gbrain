/**
 * v0.42.11.0 (#1784) — non-TTY output contract E2E (the `cmd </dev/null` smoke
 * test the issue asked for).
 *
 * `jobs watch` is the command whose PRIMARY output was gated on isTTY: non-TTY
 * callers (subagent / pipe / cron) got JSON-only with no way to a human view,
 * and the loop ran forever. The fix decouples FORMAT (--json) from LOOP
 * (--follow, default=isTTY), so a non-TTY run prints ONE human snapshot and
 * exits.
 *
 * This drives the REAL binary in a non-TTY child (stdin ignored, stdout piped →
 * `process.stdout.isTTY` is false), so it exercises the exact path subagents and
 * pipes hit. Hermetic PGLite brain in a temp HOME; no Postgres, no API keys.
 *
 * Serial because it spawns subprocesses against a temp brain and PGLite is a
 * single-writer engine.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('non-TTY output contract: jobs watch (#1784)', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-nontty-e2e-'));
    env = { ...process.env, GBRAIN_HOME: home };
    // Fresh local PGLite brain so `jobs watch` has an engine to read.
    execFileSync('bun', ['run', 'src/cli.ts', 'init', '--pglite', '--no-embedding', '--non-interactive'], {
      cwd: process.cwd(), env, stdio: 'ignore',
    });
  }, 60_000);

  afterAll(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test('non-TTY, no flags → ONE human snapshot, non-empty, not JSON, exit 0', () => {
    // stdin 'ignore' + stdout 'pipe' makes the child non-TTY on both ends.
    const out = execFileSync('bun', ['run', 'src/cli.ts', 'jobs', 'watch'], {
      cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', timeout: 30_000,
    });
    expect(out.length).toBeGreaterThan(0);                 // the bug was (no output)
    expect(out).toContain('gbrain jobs watch');            // human renderer header
    expect(out).toContain('Queue');                        // human panel
    expect(out.trimStart().startsWith('{')).toBe(false);   // NOT JSON by default
  }, 35_000);

  test('non-TTY, --json → ONE JSON snapshot, parses, exit 0', () => {
    const out = execFileSync('bun', ['run', 'src/cli.ts', 'jobs', 'watch', '--json'], {
      cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', timeout: 30_000,
    });
    const firstLine = out.split('\n').find(l => l.trim().length > 0) ?? '';
    const parsed = JSON.parse(firstLine);
    expect(parsed.event).toBe('jobs.watch.snapshot');
    expect(parsed.queue_health).toBeDefined();
  }, 35_000);
});
