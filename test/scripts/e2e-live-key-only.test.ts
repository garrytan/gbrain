/**
 * One shared live-key exclusion list (scripts/e2e-live-key-only.txt) feeds
 * both run-e2e.sh's default corpus and the ci-local smoke check, so the
 * smoke's expected count can no longer drift from what the runner lists
 * (ci:local failed before any test ran: expected glob+1, runner printed
 * glob+1-4).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..', '..');
const listed = readFileSync(join(repo, 'scripts/e2e-live-key-only.txt'), 'utf8')
  .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));

describe('shared live-key E2E exclusion list', () => {
  test('every listed file exists under test/e2e', () => {
    expect(listed.length).toBeGreaterThan(0);
    for (const file of listed) {
      expect(file).toMatch(/^test\/e2e\/[^/]+\.test\.ts$/);
      expect(existsSync(join(repo, file))).toBe(true);
    }
  });

  test('run-e2e.sh --dry-run-list skips exactly the listed files', () => {
    const result = spawnSync('bash', ['scripts/run-e2e.sh', '--dry-run-list'], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, SHARD: '', COVERAGE_DIR: '' },
    });
    expect(result.status, result.stderr).toBe(0);
    const expected = [...readdirSync(join(repo, 'test/e2e')).filter(f => f.endsWith('.test.ts')).map(f => `test/e2e/${f}`)
      .filter(f => !listed.includes(f)), 'test/phantom-redirect-engine-parity.test.ts'].sort();
    expect(result.stdout.trim().split('\n').sort()).toEqual(expected);
  });

  test('the ci-local smoke check passes against the same list', () => {
    const result = spawnSync('bash', ['scripts/ci-local-e2e-smoke.sh'], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, SHARD: '', COVERAGE_DIR: '' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[ci-local] Smoke OK');
  });

  test('ci-local.sh delegates the smoke check instead of counting the glob itself', () => {
    const ciLocal = readFileSync(join(repo, 'scripts/ci-local.sh'), 'utf8');
    expect(ciLocal).toContain('bash scripts/ci-local-e2e-smoke.sh');
    expect(ciLocal).not.toContain('EXPECTED_ALL=');
    const runE2e = readFileSync(join(repo, 'scripts/run-e2e.sh'), 'utf8');
    expect(runE2e).toContain('e2e-live-key-only.txt');
    for (const file of listed) expect(runE2e).not.toContain(file);
  });
});
