/**
 * E2E Upgrade Tests — Tier 1 (no API keys required, needs network)
 *
 * Tests the check-update command against the real GitHub API.
 * Skips gracefully if network is unavailable.
 *
 * Run: bun test test/e2e/upgrade.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { VERSION } from '../../src/version.ts';
import { isMinorOrMajorBump } from '../../src/commands/check-update.ts';

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
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'check-update', '--json'], {
      cwd: new URL('../..', import.meta.url).pathname,
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
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'check-update'], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain('GBrain');
  });

  test('check-update --help prints usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'check-update', '--help'], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain('check-update');
    expect(stdout).toContain('--json');
  });

  test('check-update --json contract holds regardless of real release state', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'check-update', '--json'], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    // Don't pin update_available to a literal value — the repo may or may not
    // have a published release. Assert the JSON shape instead.
    expect(typeof output.update_available).toBe('boolean');
    expect(output.current_version).toBe(VERSION);
    if (output.latest_version != null) {
      expect(typeof output.latest_version).toBe('string');
    }
    if (output.release_url != null) {
      expect(typeof output.release_url).toBe('string');
    }
  });

  test('version comparison wiring works end-to-end', () => {
    // Smoke test that the exported function works correctly
    expect(isMinorOrMajorBump('0.4.0', '0.5.0')).toBe(true);
    expect(isMinorOrMajorBump('0.4.0', '0.4.1')).toBe(false);
    expect(isMinorOrMajorBump('0.4.0', '1.0.0')).toBe(true);
    expect(isMinorOrMajorBump('0.4.0', '0.4.0')).toBe(false);
  });
});
