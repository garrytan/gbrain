/**
 * Tests for scripts/skillify-check.ts.
 *
 * Covers:
 *   - Runs against a known-well-skilled file (publish.ts) and produces a
 *     result object with score > 0.
 *   - --json emits parseable JSON with the expected shape.
 *   - --recent runs without crashing and returns an array of results.
 *   - A bogus target path reports required gaps (missing code file, etc.).
 */

import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { join } from 'path';

const REPO = join(__dirname, '..');
const SCRIPT = join(REPO, 'scripts', 'skillify-check.ts');

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bun', ['run', SCRIPT, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString?.() ?? '',
      stderr: err.stderr?.toString?.() ?? '',
    };
  }
}

describe('skillify-check CLI', () => {
  test('text mode runs against a known-skilled file', () => {
    // publish is one of the gbrain commands with SKILL.md + tests +
    // resolver entry. Should get a non-zero score.
    const result = run(['src/commands/publish.ts']);
    expect(result.stdout).toContain('[publish]');
    expect(result.stdout).toContain('SKILL.md exists');
    expect(result.stdout).toContain('Unit tests');
    expect(result.stdout).toContain('Resolver entry');
    // Score format: "N/10"
    expect(result.stdout).toMatch(/\d+\/\d+/);
  });

  test('--json emits a parseable array with the expected shape', () => {
    const result = run(['src/commands/publish.ts', '--json']);
    expect(result.stdout.trim()).toMatch(/^\[/);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    const r = parsed[0];
    expect(r.path).toBe('src/commands/publish.ts');
    expect(r.skillName).toBe('publish');
    expect(Array.isArray(r.items)).toBe(true);
    expect(r.items.length).toBeGreaterThanOrEqual(10);
    expect(typeof r.score).toBe('number');
    expect(typeof r.total).toBe('number');
    expect(typeof r.recommendation).toBe('string');
    // Every item has the expected keys
    for (const item of r.items) {
      expect(typeof item.name).toBe('string');
      expect(typeof item.passed).toBe('boolean');
      expect(typeof item.required).toBe('boolean');
    }
  });

  test('--recent produces JSON with results for recent files', () => {
    const result = run(['--recent', '--json']);
    // --recent may find zero files on a cold clone; either way JSON must parse.
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    // If any results returned, they must have the expected shape.
    if (parsed.length > 0) {
      expect(typeof parsed[0].score).toBe('number');
      expect(typeof parsed[0].recommendation).toBe('string');
    }
  });

  test('bogus target reports `Code file exists: false` as a required gap', () => {
    const result = run(['src/definitely-not-a-real-file.ts', '--json']);
    const parsed = JSON.parse(result.stdout);
    const codeCheck = parsed[0].items.find((i: any) => i.name === 'Code file exists');
    expect(codeCheck.passed).toBe(false);
    expect(codeCheck.required).toBe(true);
    // Overall recommendation should flag the gap.
    expect(parsed[0].recommendation).toMatch(/skillify|create|missing/);
    // Exit code non-zero
    expect(result.exitCode).toBe(1);
  });
});
