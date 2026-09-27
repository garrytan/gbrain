import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { E2E_EXCLUSIONS, prepareMatrix, validateRow } from '../../scripts/e2e-matrix.ts';

const repo = join(import.meta.dir, '../..');
const paths = ['a', 'b', 'c', 'd', 'e'].map(n => `test/e2e/${n}.test.ts`);
const weights = new Map(paths.map((f, i) => [f, 100 - i * 10]));
function fixture(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-e2e-matrix-'));
  try {
    mkdirSync(join(root, 'test/e2e'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    for (const file of paths) writeFileSync(join(root, file), '// fixture');
    fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function worker(root: string, row: unknown) {
  return spawnSync(process.execPath, [join(repo, 'scripts/e2e-matrix.ts'), 'run'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, SHARD: '2/4', E2E_MATRIX_ROW: JSON.stringify(row) },
  });
}
describe('frozen E2E matrix', () => {
  test('partitions the exact selection once, with deterministic weights and at most four workers', () => {
    const matrix = prepareMatrix(paths, weights);
    expect(matrix.include).toHaveLength(4);
    expect(matrix.include.flatMap(r => r.files).sort()).toEqual(paths);
    expect(prepareMatrix(paths, weights)).toEqual(matrix);
    expect(prepareMatrix(paths.slice(0, 2), weights).include).toHaveLength(2);
  });
  test('filters only the existing named/live exclusions and emits an explicit empty sentinel', () => {
    expect(prepareMatrix([...E2E_EXCLUSIONS, paths[0]], weights).include).toEqual([{ shard: 1, files: [paths[0]], empty: false }]);
    expect(prepareMatrix([], weights).include).toEqual([{ shard: 1, files: [], empty: true }]);
    expect(prepareMatrix([...E2E_EXCLUSIONS], weights).include[0].empty).toBe(true);
  });
  test('refuses invalid selections and duplicate paths', () => {
    for (const files of [[paths[0], paths[0]], ['../outside.test.ts'], ['test/e2e/../escape.test.ts'], ['test/e2e/$(touch marker).test.ts']]) expect(() => prepareMatrix(files, weights)).toThrow();
  });
  test('empty sentinel launches no runner; missing/malformed input fails instead of selecting all', () => fixture(root => {
    writeFileSync(join(root, 'scripts/run-e2e.sh'), 'exit 99\n');
    expect(worker(root, { shard: 1, files: [], empty: true }).status).toBe(0);
    for (const row of [null, {}, { shard: 1, files: [], empty: false }, { shard: 2, files: [], empty: true }, { shard: 5, files: [paths[0]], empty: false }]) expect(worker(root, row).status).not.toBe(0);
  }));
  test('worker executes the complete frozen argv and clears inherited SHARD', () => fixture(root => {
    writeFileSync(join(root, 'scripts/run-e2e.sh'), 'test -z "${SHARD:-}" || exit 81\nprintf "FILE:%s\\n" "$@"\n');
    const r = worker(root, { shard: 2, files: paths, empty: false });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split('\n').filter(l => l.startsWith('FILE:'))).toEqual(paths.map(p => `FILE:${p}`));
  }));
  test('worker rejects missing, excluded, duplicate and symlink-escaping files', () => fixture(root => {
    writeFileSync(join(root, 'outside.test.ts'), '// outside');
    symlinkSync(join(root, 'outside.test.ts'), join(root, 'test/e2e/escape.test.ts'));
    for (const files of [['test/e2e/missing.test.ts'], [paths[0], paths[0]], ['test/e2e/escape.test.ts'], ['test/e2e/mechanical.test.ts']]) expect(() => validateRow({ shard: 1, files, empty: false }, root)).toThrow();
  }));
  test('propagates runner failure without marking an executed partition successful', () => fixture(root => {
    writeFileSync(join(root, 'scripts/run-e2e.sh'), 'exit 17\n');
    expect(worker(root, { shard: 1, files: [paths[0]], empty: false }).status).toBe(17);
  }));
  test.each(['SIGTERM', 'SIGINT'] as const)('forwards %s cancellation to its owned runner and preserves its exit status', async (signal) => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-e2e-matrix-cancel-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let runnerPid = 0;
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'test/e2e'), { recursive: true });
      writeFileSync(join(root, paths[0]), '// frozen fixture');
      // Trap the actual signal in a portable shell child. Its completion marker
      // proves the wrapper forwarded cancellation instead of merely dying.
      writeFileSync(join(root, 'scripts/run-e2e.sh'), `trap 'printf "SIGTERM\\n" > received.txt; exit 143' TERM
trap 'printf "SIGINT\\n" > received.txt; exit 130' INT
printf '%s\\n' "$$" > runner.pid
while :; do sleep 0.05; done
`);
      child = Bun.spawn([process.execPath, join(repo, 'scripts/e2e-matrix.ts'), 'run'], {
        cwd: root,
        env: { ...process.env, SHARD: '4/4', E2E_MATRIX_ROW: JSON.stringify({ shard: 1, files: [paths[0]], empty: false }) },
        stdout: 'ignore', stderr: 'ignore',
      });
      const readyDeadline = Date.now() + 5000;
      while (!existsSync(join(root, 'runner.pid')) && Date.now() < readyDeadline) await Bun.sleep(20);
      expect(existsSync(join(root, 'runner.pid'))).toBe(true);
      runnerPid = Number(readFileSync(join(root, 'runner.pid'), 'utf8'));
      child.kill(signal);
      const exitDeadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < exitDeadline) await Bun.sleep(20);
      expect(child.exitCode).toBe(signal === 'SIGINT' ? 130 : 143);
      expect(readFileSync(join(root, 'received.txt'), 'utf8').trim()).toBe(signal);
      expect(() => process.kill(runnerPid, 0)).toThrow();
    } finally {
      child?.kill('SIGKILL');
      if (runnerPid) { try { process.kill(runnerPid, 'SIGKILL'); } catch { /* already reaped */ } }
      if (child) await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
});
