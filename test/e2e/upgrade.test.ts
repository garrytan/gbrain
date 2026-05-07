/**
 * E2E Upgrade Tests — Tier 1 (no API keys required, needs network)
 *
 * Tests the check-update command against the real GitHub API.
 * Skips gracefully if network is unavailable.
 *
 * Run: bun test test/e2e/upgrade.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { fileURLToPath } from 'url';
import { VERSION } from '../../src/version.ts';
import { isMinorOrMajorBump } from '../../src/commands/check-update.ts';

const bunExe = process.execPath;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Check if we can reach GitHub
async function hasNetwork(): Promise<boolean> {
  try {
    const res = await fetch('https://api.github.com', { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const skip = !(await hasNetwork());
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E upgrade tests (network unavailable)');
}

describeE2E('E2E: Check-Update', () => {
  test('check-update --json returns valid JSON with current version', async () => {
    const proc = Bun.spawn([bunExe, 'run', 'src/cli.ts', 'check-update', '--json'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.current_version).toBe(VERSION);
    expect(output.current_source).toBe('package-json');
    expect(typeof output.update_available).toBe('boolean');
    expect(typeof output.upgrade_command).toBe('string');
  });

  test('check-update without --json prints human-readable output', async () => {
    const proc = Bun.spawn([bunExe, 'run', 'src/cli.ts', 'check-update'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain('GBrain');
  });

  test('check-update --help prints usage', async () => {
    const proc = Bun.spawn([bunExe, 'run', 'src/cli.ts', 'check-update', '--help'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain('check-update');
    expect(stdout).toContain('--json');
  });

  test('handles no-releases gracefully (current repo state)', async () => {
    const proc = Bun.spawn([bunExe, 'run', 'src/cli.ts', 'check-update', '--json'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    // With no releases, should return false and an error
    expect(output.update_available).toBe(false);
  });

  test('version comparison wiring works end-to-end', () => {
    // Smoke test that the exported function works correctly
    expect(isMinorOrMajorBump('0.4.0', '0.5.0')).toBe(true);
    expect(isMinorOrMajorBump('0.4.0', '0.4.1')).toBe(false);
    expect(isMinorOrMajorBump('0.4.0', '1.0.0')).toBe(true);
    expect(isMinorOrMajorBump('0.4.0', '0.4.0')).toBe(false);
  });
});
