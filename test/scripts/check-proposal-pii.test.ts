/**
 * Tests for scripts/check-proposal-pii.sh — the privacy guard for
 * docs/proposals/*.md.
 *
 * Strategy: each test case builds a tiny git-initialized scratch repo
 * with a docs/proposals/*.md file containing the case input, invokes
 * the script (which lives back in the real repo), and asserts the exit
 * code + stderr signal. The script reads from `git rev-parse
 * --show-toplevel` so each scratch repo behaves like a real project.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT_PATH = join(import.meta.dir, '..', '..', 'scripts', 'check-proposal-pii.sh');

function runLintIn(content: string | null): { exitCode: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-pii-lint-'));
  try {
    // Initialize as git repo so `git rev-parse --show-toplevel` resolves.
    spawnSync('git', ['init', '-q'], { cwd: dir });
    if (content !== null) {
      mkdirSync(join(dir, 'docs', 'proposals'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'proposals', 'test.md'), content);
    }
    const r = spawnSync('bash', [SCRIPT_PATH], { cwd: dir, encoding: 'utf8' });
    return { exitCode: r.status ?? -1, stderr: r.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-proposal-pii.sh', () => {
  test('clean proposal passes (exit 0)', () => {
    const r = runLintIn(`# RFC

This is a clean technical proposal using only generic placeholders:
alice-example, acme-corp, fund-a. Two roles, one decision.
`);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  });

  test('garrytan/brain private repo reference is flagged', () => {
    const r = runLintIn(`Context: findings resolved in garrytan/brain.\n`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('garrytan/brain');
  });

  test('trial separation phrase is flagged', () => {
    const r = runLintIn(`A: trial separation\nB: confirmed status\n`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('trial separation');
  });

  test('permanent separation phrase is flagged', () => {
    const r = runLintIn(`status: permanent separation, confirmed\n`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('permanent separation');
  });

  test('couples session phrase is flagged', () => {
    const r = runLintIn(`per the couples session on 2026-05-07\n`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('couples session');
  });

  test('divorce attorney phrase is flagged', () => {
    const r = runLintIn(`consultation with divorce attorney scheduled\n`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('divorce attorney');
  });

  test("grandmother's funeral phrase is flagged", () => {
    const r = runLintIn(`Traveled for the grandmother's funeral last week.\n`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("grandmother's funeral");
  });

  test("aunt's funeral phrase is flagged", () => {
    const r = runLintIn(`Traveled to the aunt's funeral in Toronto.\n`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("aunt's funeral");
  });

  test('wintermute is flagged (consistent with check-privacy.sh)', () => {
    const r = runLintIn(`Author: Wintermute (via the user)\n`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('wintermute');
  });

  test('case-insensitive match: WINTERMUTE all-caps also flagged', () => {
    const r = runLintIn(`See the WINTERMUTE deployment.\n`);
    expect(r.exitCode).toBe(1);
  });

  test('benign separation usage stays clean (separation-of-concerns)', () => {
    // "separation" alone is fine; only "trial separation" / "permanent
    // separation" are flagged. Software vocabulary survives.
    const r = runLintIn(`# Architecture

Strict separation of concerns between the runner and the judge module.
The trial run uses a separate test database.
`);
    expect(r.exitCode).toBe(0);
  });

  test('benign funeral metaphor stays clean (bare "funeral" not banned)', () => {
    // Only combined personal-context phrases are banned. Bare "funeral"
    // in a software metaphor survives the lint.
    const r = runLintIn(`Killing the deprecated endpoint feels like a funeral.\n`);
    expect(r.exitCode).toBe(0);
  });

  test('multiple PII patterns reported together with exit 1', () => {
    const r = runLintIn(`
Context: findings from garrytan/brain.

A: trial separation
B: permanent separation per the couples session
`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('garrytan/brain');
    expect(r.stderr).toContain('trial separation');
    expect(r.stderr).toContain('permanent separation');
    expect(r.stderr).toContain('couples session');
    // Summary count.
    expect(r.stderr).toContain('4 PII pattern hit(s)');
  });

  test('no proposals dir → exits 0 (not a failure)', () => {
    const r = runLintIn(null);
    expect(r.exitCode).toBe(0);
  });

  test('--help exits 1 with usage text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-pii-lint-help-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: dir });
      const r = spawnSync('bash', [SCRIPT_PATH, '--help'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(1);
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      expect(out).toContain('check-proposal-pii.sh');
      expect(out).toContain('docs/proposals');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
