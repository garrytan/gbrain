import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');

function doctorJson(topStatus: string, checks: number): string {
  const rows = Array.from({ length: checks }, (_, i) => ({
    name: `check_${i}`,
    status: 'ok',
    message: 'fine',
    elapsed_ms: 1,
    category: 'brain',
  }));
  return JSON.stringify({ schema_version: 2, status: topStatus, health_score: 80, checks: rows });
}

function runMatrix(doctorOut: string) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-pg-matrix-'));
  try {
    mkdirSync(join(root, 'tests', 'heavy'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    copyFileSync(join(REPO, 'tests', 'heavy', 'pg_upgrade_matrix.sh'), join(root, 'tests', 'heavy', 'pg_upgrade_matrix.sh'));
    writeFileSync(join(root, 'tests', 'heavy', '_db_floor.sh'), '');
    writeFileSync(join(root, 'tests', 'heavy', '_build_legacy_fixtures.sh'), '#!/usr/bin/env bash\nexit 0\n');
    const payload = join(root, 'doctor.json');
    writeFileSync(payload, doctorOut);
    const fakeBun = join(root, 'bin', 'bun');
    writeFileSync(fakeBun, `#!/usr/bin/env bash\ncat '${payload}'\n`);
    chmodSync(fakeBun, 0o755);
    return spawnSync('bash', [join(root, 'tests', 'heavy', 'pg_upgrade_matrix.sh')], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        HOME: root,
        GBRAIN_HOME: join(root, 'home'),
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5434/gbrain_test',
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('tests/heavy/pg_upgrade_matrix.sh reads doctor status from a large report', () => {
  test('a doctor report whose status fields pass one pipe buffer still walks forward (no SIGPIPE exit 141)', () => {
    const report = doctorJson('warnings', 400);
    expect(report.length).toBeGreaterThan(16_384);
    const result = runMatrix(report);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('OK: shape=pre-v0.13 → status=warnings');
    expect(result.stdout).toContain('OK — all 2 shape(s) walked forward cleanly.');
  });

  test('a large report with a failing top-level status still fails each shape by name', () => {
    const result = runMatrix(doctorJson('fail', 400));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FAIL: shape=pre-v0.13 doctor reported status='fail'");
    expect(result.stderr).toContain("FAIL: shape=pre-v0.18 doctor reported status='fail'");
    expect(result.stderr).toContain('FAILED: 2/2 shape(s) wedged on walk-forward.');
  });

  test('a report with no status field fails by name instead of exiting silently', () => {
    const result = runMatrix(JSON.stringify({ schema_version: 2, checks: [] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FAIL: shape=pre-v0.13 doctor reported status=''");
  });
});
