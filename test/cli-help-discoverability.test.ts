/**
 * v0.39.3.0 WARN-5 + WARN-6 — CLI help discoverability.
 *
 * WARN-5: `gbrain capture --help` was showing only the generic
 * `Usage: gbrain capture` line because `capture` was missing from
 * CLI_ONLY_SELF_HELP (src/cli.ts:34-53). Fix added it to the set AND
 * added a pre-engine-bind `--help` short-circuit at handleCliOnly so
 * the HELP constant is reachable on a fresh tmpdir with no config.
 *
 * WARN-6: `capture`, `brainstorm`, `lsd` were missing from the main
 * `gbrain --help` text. Added a BRAIN section to printHelp.
 *
 * These tests spawn `bun run src/cli.ts` as a subprocess so they
 * exercise the real dispatcher flow end-to-end (no mocking of
 * cli.ts internals).
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, GBRAIN_HOME: '/tmp/gbrain-test-help-nonexistent' },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe('WARN-5 — `gbrain capture --help` reaches the detailed HELP constant', () => {
  test('output contains every documented flag', () => {
    const { stdout, status } = runCli(['capture', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--slug');
    expect(stdout).toContain('--type');
    expect(stdout).toContain('--file');
    expect(stdout).toContain('--stdin');
    expect(stdout).toContain('--source');
    expect(stdout).toContain('--quiet');
    expect(stdout).toContain('--json');
  });

  test('output is NOT the generic short-circuit fallback', () => {
    const { stdout } = runCli(['capture', '--help']);
    // Pre-fix output was: "Usage: gbrain capture\n\ngbrain capture - run gbrain --help ..."
    // Post-fix HELP is much longer and includes Examples.
    expect(stdout).toContain('Examples:');
    expect(stdout.split('\n').length).toBeGreaterThan(10);
    expect(stdout).not.toMatch(/^Usage: gbrain capture\s*$/m);
  });

  test('-h short flag also works', () => {
    const { stdout, status } = runCli(['capture', '-h']);
    expect(status).toBe(0);
    expect(stdout).toContain('--file PATH');
  });
});

describe('WARN-6 — main `gbrain --help` lists capture/brainstorm/lsd', () => {
  test('output mentions all three commands by name', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    // Must appear as command names (not just words in prose somewhere)
    expect(stdout).toMatch(/^\s*capture\s/m);
    expect(stdout).toMatch(/^\s*brainstorm\s/m);
    expect(stdout).toMatch(/^\s*lsd\s/m);
  });

  test('BRAIN section heading is present and groups the three commands', () => {
    const { stdout } = runCli(['--help']);
    expect(stdout).toContain('BRAIN');
    // The 3 commands should appear AFTER the BRAIN heading in textual order.
    const brainIdx = stdout.indexOf('BRAIN');
    expect(brainIdx).toBeGreaterThan(-1);
    expect(stdout.indexOf('capture', brainIdx)).toBeGreaterThan(brainIdx);
    expect(stdout.indexOf('brainstorm', brainIdx)).toBeGreaterThan(brainIdx);
    expect(stdout.indexOf('lsd', brainIdx)).toBeGreaterThan(brainIdx);
  });

  test('regression: existing top-level commands still listed', () => {
    // Snapshot guard against accidentally deleting other groups when we
    // added the BRAIN section. Spot-check a few commands from different
    // groups (SETUP, PAGES, SEARCH, IMPORT/EXPORT).
    const { stdout } = runCli(['--help']);
    expect(stdout).toContain('init');
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('get');
    expect(stdout).toContain('search');
    expect(stdout).toContain('query');
    expect(stdout).toContain('import');
    expect(stdout).toContain('export');
    expect(stdout).toContain('files');
    expect(stdout).toContain('embed');
  });
});
