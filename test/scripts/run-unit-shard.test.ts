/**
 * Regression test (b): scripts/run-unit-shard.sh exclusion symmetry.
 *
 * Pins the contract that the local fast-loop unit-shard script:
 *   1. EXCLUDES *.slow.test.ts (those run via scripts/run-slow-tests.sh).
 *   2. EXCLUDES *.serial.test.ts (those run via scripts/run-serial-tests.sh
 *      after the parallel pass).
 *   3. Includes plain *.test.ts files (the fast-loop unit set).
 *
 * Without this guard, a future refactor that drops one of the `-not -name`
 * clauses from the find expression would cause slow OR serial files to
 * run inside the parallel pass — silently undoing the quarantine and
 * re-introducing the contention flakes that motivated v0.26.4.
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');
const SERIAL_SH = resolve(REPO_ROOT, 'scripts/run-serial-tests.sh');

function dryRunList(): string[] {
  const out = execFileSync('bash', [SHARD_SH, '--dry-run-list'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: '' },
  });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

describe('run-unit-shard.sh exclusion symmetry', () => {
  it('lists at least one plain *.test.ts file', () => {
    const files = dryRunList();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => /\.test\.ts$/.test(f) && !/\.(slow|serial)\.test\.ts$/.test(f))).toBe(true);
  });

  it('excludes every *.slow.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.slow\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes every *.serial.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.serial\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes the test/e2e/ subtree', () => {
    const files = dryRunList();
    const leaks = files.filter(f => f.startsWith('test/e2e/'));
    expect(leaks).toEqual([]);
  });
});

describe('run-unit-shard.sh bounded process batches', () => {
  it('runs every selected file exactly once across fresh Bun batches', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-unit-batches-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'test'), { recursive: true });
      mkdirSync(join(root, 'bin'), { recursive: true });
      copyFileSync(SHARD_SH, join(root, 'scripts', 'run-unit-shard.sh'));
      chmodSync(join(root, 'scripts', 'run-unit-shard.sh'), 0o755);

      for (let i = 1; i <= 6; i++) {
        writeFileSync(join(root, 'test', `${i}.test.ts`), '// fixture\n');
      }
      writeFileSync(join(root, 'test', 'migrate.test.ts'), '// cold fixture\n');
      writeFileSync(join(root, 'test', 'embedding-dim-check.test.ts'), '// fresh-schema fixture\n');

      const callsPath = join(root, 'bun-calls.txt');
      writeFileSync(
        join(root, 'bin', 'bun'),
        `#!/usr/bin/env bash\nprintf 'snapshot=%s args=%s\\n' "\${GBRAIN_PGLITE_SNAPSHOT-}" "$*" >> "${callsPath}"\n`,
      );
      chmodSync(join(root, 'bin', 'bun'), 0o755);

      const result = spawnSync('bash', [join(root, 'scripts', 'run-unit-shard.sh'), '--batch-size', '3'], {
        cwd: root,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
          SHARD: '',
          GBRAIN_PGLITE_SNAPSHOT: '/tmp/fixture.tar',
        },
      });
      expect(result.status).toBe(0);

      const calls = readFileSync(callsPath, 'utf-8').trim().split('\n');
      expect(calls).toHaveLength(3);
      expect(calls.map(line => line.match(/test\/(?:[0-9]+|migrate|embedding-dim-check)\.test\.ts/g)?.length ?? 0)).toEqual([3, 3, 2]);
      const selected = calls.flatMap(line => line.match(/test\/(?:[0-9]+|migrate|embedding-dim-check)\.test\.ts/g) ?? []).sort();
      expect(selected).toEqual([
        ...Array.from({ length: 6 }, (_, i) => `test/${i + 1}.test.ts`),
        'test/embedding-dim-check.test.ts',
        'test/migrate.test.ts',
      ]);
      expect(calls.filter(line => /test\/(?:migrate|embedding-dim-check)\.test\.ts/.test(line))[0]).toStartWith('snapshot= args=');
      expect(calls.filter(line => /test\/[0-9]+\.test\.ts/.test(line)).every(line => line.startsWith('snapshot=/tmp/fixture.tar args='))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops the shard after a failed batch and reports unrun batches', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-unit-batch-failure-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'test'), { recursive: true });
      mkdirSync(join(root, 'bin'), { recursive: true });
      copyFileSync(SHARD_SH, join(root, 'scripts', 'run-unit-shard.sh'));
      chmodSync(join(root, 'scripts', 'run-unit-shard.sh'), 0o755);
      for (let i = 1; i <= 4; i++) writeFileSync(join(root, 'test', `${i}.test.ts`), '// fixture\n');

      const callsPath = join(root, 'bun-calls.txt');
      const markerPath = join(root, 'failed-once');
      writeFileSync(
        join(root, 'bin', 'bun'),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${callsPath}"\nif [ ! -f "${markerPath}" ]; then touch "${markerPath}"; exit 7; fi\n`,
      );
      chmodSync(join(root, 'bin', 'bun'), 0o755);

      const result = spawnSync('bash', [join(root, 'scripts', 'run-unit-shard.sh'), '--batch-size', '2'], {
        cwd: root,
        encoding: 'utf-8',
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, SHARD: '' },
      });
      expect(result.status).toBe(7);
      expect(readFileSync(callsPath, 'utf-8').trim().split('\n')).toHaveLength(1);
      expect(result.stderr).toContain('ABORTED after failed batch 1/2 rc=7');
      expect(result.stderr).toContain('remaining batches were not run');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a zero batch size before launching Bun', () => {
    const result = spawnSync('bash', [SHARD_SH, '--batch-size', '0'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, SHARD: '' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid batch size');
  });

  it('rejects a zero cold-path batch size before launching Bun', () => {
    const result = spawnSync('bash', [SHARD_SH], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, SHARD: '', GBRAIN_TEST_COLD_BATCH_SIZE: '0' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid cold batch size');
  });
});

describe('run-serial-tests.sh cold-path snapshot opt-out', () => {
  it('clears snapshot env for migration contracts but preserves it for normal serial files', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-serial-snapshot-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'test'), { recursive: true });
      mkdirSync(join(root, 'bin'), { recursive: true });
      copyFileSync(SERIAL_SH, join(root, 'scripts', 'run-serial-tests.sh'));
      chmodSync(join(root, 'scripts', 'run-serial-tests.sh'), 0o755);
      writeFileSync(join(root, 'test', 'normal.serial.test.ts'), '// fixture\n');
      writeFileSync(join(root, 'test', 'apply-migrations.serial.test.ts'), '// fixture\n');
      writeFileSync(join(root, 'test', 'unified-multimodal.serial.test.ts'), '// fixture\n');

      const callsPath = join(root, 'bun-calls.txt');
      writeFileSync(
        join(root, 'bin', 'bun'),
        `#!/usr/bin/env bash\nprintf 'snapshot=%s args=%s\\n' "\${GBRAIN_PGLITE_SNAPSHOT-}" "$*" >> "${callsPath}"\n`,
      );
      chmodSync(join(root, 'bin', 'bun'), 0o755);

      const result = spawnSync('bash', [join(root, 'scripts', 'run-serial-tests.sh')], {
        cwd: root,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
          GBRAIN_PGLITE_SNAPSHOT: '/tmp/fixture.tar',
        },
      });
      expect(result.status).toBe(0);
      const calls = readFileSync(callsPath, 'utf-8').trim().split('\n');
      expect(calls.find(line => line.includes('normal.serial.test.ts'))).toStartWith('snapshot=/tmp/fixture.tar args=');
      expect(calls.find(line => line.includes('apply-migrations.serial.test.ts'))).toStartWith('snapshot= args=');
      expect(calls.find(line => line.includes('unified-multimodal.serial.test.ts'))).toStartWith('snapshot= args=');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
