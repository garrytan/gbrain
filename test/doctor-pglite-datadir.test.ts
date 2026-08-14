/**
 * `doctor` pglite_data_dir check (#223 WAL-repair wave) — parallel-safe unit
 * coverage of:
 *
 *  - `computePgliteDataDirCheck` — the PURE verdict → Check mapping in
 *    src/commands/doctor.ts (synthetic PgliteDirDiagnosis inputs, no fs).
 *  - `OPS_CHECK_NAMES` carrying 'pglite_data_dir' (category routing).
 *  - `inspectPgliteDataDir` — the read-only diagnoser in
 *    src/core/pglite-repair.ts, exercised against synthetic on-disk layouts
 *    in hermetic mkdtemp dirs.
 *
 * No process.env writes, no PGLite cold starts — safe for the parallel unit
 * shards. The command-level (real repair) coverage lives in
 * test/pglite-repair-command.serial.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computePgliteDataDirCheck } from '../src/commands/doctor.ts';
import { OPS_CHECK_NAMES } from '../src/core/doctor-categories.ts';
import { inspectPgliteDataDir } from '../src/core/pglite-repair.ts';
import type { PgliteDirDiagnosis } from '../src/core/pglite-repair.ts';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Synthetic diagnosis with healthy-looking defaults; override per case. */
function makeDiagnosis(
  overrides: Partial<PgliteDirDiagnosis> & { verdict: PgliteDirDiagnosis['verdict'] },
): PgliteDirDiagnosis {
  return {
    exists: true,
    postmasterPid: false,
    pgControlOk: true,
    pgVersion: '17',
    walSegments: [],
    lockHeld: false,
    lockHolderPid: null,
    backupDirs: [],
    recentAttempts: [],
    detail: 'synthetic diagnosis',
    ...overrides,
  };
}

/**
 * A minimal fake PG17 pglite layout that passes `validateWalRepairTarget`:
 * PG_VERSION '17', base/ dir, 8192-byte global/pg_control, empty pg_wal/.
 */
function makeFakeLayout(dir: string): void {
  mkdirSync(join(dir, 'base'), { recursive: true });
  mkdirSync(join(dir, 'global'), { recursive: true });
  mkdirSync(join(dir, 'pg_wal'), { recursive: true });
  writeFileSync(join(dir, 'PG_VERSION'), '17\n');
  writeFileSync(join(dir, 'global', 'pg_control'), Buffer.alloc(8192));
}

describe('computePgliteDataDirCheck — verdict → Check mapping', () => {
  const DIR = '/synthetic/brain.pglite';

  test('every verdict maps to a check named pglite_data_dir with human_only remediation', () => {
    const verdicts: PgliteDirDiagnosis['verdict'][] = [
      'looks-healthy',
      'wal-corruption-likely',
      'locked',
      'missing',
      'unsupported-layout',
    ];
    for (const verdict of verdicts) {
      const check = computePgliteDataDirCheck(DIR, makeDiagnosis({ verdict }));
      expect(check.name).toBe('pglite_data_dir');
      expect(check.remediation_status).toBe('human_only');
    }
  });

  test('wal-corruption-likely → fail, names pglite-repair --dry-run and #223', () => {
    const check = computePgliteDataDirCheck(
      DIR,
      makeDiagnosis({
        verdict: 'wal-corruption-likely',
        postmasterPid: true,
        detail: 'stale postmaster.pid present',
      }),
    );
    expect(check.status).toBe('fail');
    expect(check.message).toContain('pglite-repair --dry-run');
    expect(check.message).toContain('#223');
    expect(check.message).toContain('gbrain pglite-repair');
  });

  test('looks-healthy (but connect failed) → fail, points at gbrain pglite-repair', () => {
    const check = computePgliteDataDirCheck(DIR, makeDiagnosis({ verdict: 'looks-healthy' }));
    expect(check.status).toBe('fail');
    expect(check.message).toContain('gbrain pglite-repair');
  });

  test('unsupported-layout → fail', () => {
    const check = computePgliteDataDirCheck(
      DIR,
      makeDiagnosis({ verdict: 'unsupported-layout', pgControlOk: false, pgVersion: null }),
    );
    expect(check.status).toBe('fail');
    expect(check.remediation_status).toBe('human_only');
  });

  test('locked → warn, names the live holder PID', () => {
    const check = computePgliteDataDirCheck(
      DIR,
      makeDiagnosis({ verdict: 'locked', lockHeld: true, lockHolderPid: 12345 }),
    );
    expect(check.status).toBe('warn');
    expect(check.message).toContain('12345');
  });

  test('missing → warn', () => {
    const check = computePgliteDataDirCheck(
      DIR,
      makeDiagnosis({ verdict: 'missing', exists: false, pgControlOk: false, pgVersion: null }),
    );
    expect(check.status).toBe('warn');
    expect(check.message).toContain(DIR);
  });

  test('recurrence: >=2 failed attempts within 7 days → message points at docs/ENGINES.md', () => {
    const check = computePgliteDataDirCheck(
      DIR,
      makeDiagnosis({
        verdict: 'wal-corruption-likely',
        postmasterPid: true,
        recentAttempts: [
          { ts: Date.now() - 1000, outcome: 'failed' },
          { ts: Date.now() - 2000, outcome: 'failed' },
        ],
      }),
    );
    expect(check.status).toBe('fail');
    expect(check.message).toContain('docs/ENGINES.md');
  });

  test('single recent failed attempt does NOT trigger the engine-switch recurrence note', () => {
    const check = computePgliteDataDirCheck(
      DIR,
      makeDiagnosis({
        verdict: 'wal-corruption-likely',
        postmasterPid: true,
        recentAttempts: [{ ts: Date.now() - 1000, outcome: 'failed' }],
      }),
    );
    expect(check.message).not.toContain('docs/ENGINES.md');
  });

  test('non-empty backupDirs → message mentions the backup(s)', () => {
    const check = computePgliteDataDirCheck(
      DIR,
      makeDiagnosis({
        verdict: 'wal-corruption-likely',
        postmasterPid: true,
        backupDirs: [`${DIR}.wal-repair-backup-1700000000000`],
      }),
    );
    expect(check.message).toContain('backup');
    expect(check.message).toContain(`${DIR}.wal-repair-backup-1700000000000`);
  });
});

describe('doctor-categories', () => {
  test('OPS_CHECK_NAMES contains pglite_data_dir', () => {
    expect(OPS_CHECK_NAMES.has('pglite_data_dir')).toBe(true);
  });
});

describe('inspectPgliteDataDir — synthetic on-disk layouts', () => {
  test('(a) nonexistent path → missing', () => {
    const parent = tmp('gbrain-inspect-a-');
    const diagnosis = inspectPgliteDataDir(join(parent, 'does-not-exist.pglite'));
    expect(diagnosis.verdict).toBe('missing');
    expect(diagnosis.exists).toBe(false);
  });

  test('(b) dir without PG_VERSION → unsupported-layout', () => {
    const dir = tmp('gbrain-inspect-b-');
    const diagnosis = inspectPgliteDataDir(dir);
    expect(diagnosis.verdict).toBe('unsupported-layout');
    expect(diagnosis.pgVersion).toBeNull();
  });

  test('(c) full fake layout + stale postmaster.pid → wal-corruption-likely', () => {
    const dir = join(tmp('gbrain-inspect-c-'), 'brain.pglite');
    makeFakeLayout(dir);
    writeFileSync(join(dir, 'postmaster.pid'), '99999\n');
    const diagnosis = inspectPgliteDataDir(dir);
    expect(diagnosis.verdict).toBe('wal-corruption-likely');
    expect(diagnosis.postmasterPid).toBe(true);
    expect(diagnosis.pgVersion).toBe('17');
    expect(diagnosis.pgControlOk).toBe(true);
  });

  test('(d) full fake layout, no postmaster.pid → looks-healthy', () => {
    const dir = join(tmp('gbrain-inspect-d-'), 'brain.pglite');
    makeFakeLayout(dir);
    const diagnosis = inspectPgliteDataDir(dir);
    expect(diagnosis.verdict).toBe('looks-healthy');
    expect(diagnosis.postmasterPid).toBe(false);
    expect(diagnosis.lockHeld).toBe(false);
  });

  test('(e) fake layout + live .gbrain-lock holder → locked with the holder PID', () => {
    const dir = join(tmp('gbrain-inspect-e-'), 'brain.pglite');
    makeFakeLayout(dir);
    mkdirSync(join(dir, '.gbrain-lock'), { recursive: true });
    writeFileSync(
      join(dir, '.gbrain-lock', 'lock'),
      JSON.stringify({
        pid: process.pid, // this test process — provably alive
        acquired_at: Date.now(),
        refreshed_at: Date.now(),
        command: 'gbrain embed',
        subcommand: 'embed',
      }),
    );
    const diagnosis = inspectPgliteDataDir(dir);
    expect(diagnosis.verdict).toBe('locked');
    expect(diagnosis.lockHeld).toBe(true);
    expect(diagnosis.lockHolderPid).toBe(process.pid);
  });

  test('(f) symlinked data dir → unsupported-layout (rename-based repair refuses symlinks)', () => {
    const parent = tmp('gbrain-inspect-f-');
    const real = join(parent, 'real.pglite');
    makeFakeLayout(real);
    const link = join(parent, 'link.pglite');
    symlinkSync(real, link);
    const diagnosis = inspectPgliteDataDir(link);
    expect(diagnosis.verdict).toBe('unsupported-layout');
    expect(diagnosis.detail).toContain('symlink');
  });
});
