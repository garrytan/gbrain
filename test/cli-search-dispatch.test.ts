/**
 * T5 — `gbrain search` dispatch reconcile. Subprocess test against the real
 * cli.ts entrypoint:
 *   - `search modes`  -> read-only config dashboard (NOT a search for "modes")
 *   - `search "<q>"`  -> cheap-hybrid free-text search (NOT "Unknown subcommand")
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(args: string[], home: string) {
  const r = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '' },
    timeout: 45_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function withHome(fn: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-search-dispatch-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
  try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('T5 — gbrain search dispatch', () => {
  test('`search modes --json` routes to the dashboard (active_mode), not a query', () => {
    withHome((home) => {
      const { stdout, status } = run(['search', 'modes', '--json'], home);
      expect(status).toBe(0);
      expect(stdout).toContain('active_mode');
      // It must NOT be a search-results payload for the literal word "modes".
      expect(stdout).not.toContain('Unknown subcommand');
    });
  });

  test('`search "<freetext>"` routes to the cheap-hybrid search op (no "Unknown subcommand")', () => {
    withHome((home) => {
      const { stdout, stderr, status } = run(['search', 'zzz-no-such-page-xyz'], home);
      // Empty brain → "No results." (the search op's formatter), exit 0.
      expect(status).toBe(0);
      expect(stderr).not.toContain('Unknown subcommand');
      expect(stdout.toLowerCase()).toContain('no results');
    });
  });

  test('`search stats --json` routes to the dashboard', () => {
    withHome((home) => {
      const { stdout, status } = run(['search', 'stats', '--json'], home);
      expect(status).toBe(0);
      // stats envelope, not a search-results array.
      expect(stdout).toMatch(/total_calls|cache_hit_rate|window_days/);
    });
  });
});
