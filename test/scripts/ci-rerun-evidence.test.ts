import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildManifest, passedFiles, rerunProblem } from '../../scripts/ci-manifest.ts';
import { loadReceiptDir } from '../../scripts/ci-executed-counts.ts';

// A full run whose one flaky job got the single allowed rerun of failed jobs
// (gbrain#9679, run 44208223866): every other job's receipts stay from attempt
// 1, the rerun job's from attempt 2, and the ledger job runs again in attempt 2.
const root = join(import.meta.dir, '../..');
const RUN = 44208223866;

type Case = [file: string, name: string, status: 'pass' | 'fail'];
function receipts(dir: string, artifact: string, o: { shard: number; of: number; attempt: number; sha: string; cases: Case[] }) {
  const at = join(dir, artifact);
  mkdirSync(at, { recursive: true });
  const id = `unit--s${o.shard}--primary`;
  writeFileSync(join(at, `${id}.receipt`), `version=1\nlane=unit\nkind=primary\nshard=${o.shard}\nof=${o.of}\narm=\nsha=${o.sha}\nroot=\nrun_id=${RUN}\nrun_attempt=${o.attempt}\nstarted=${o.attempt}\nexit=${o.cases.some(c => c[2] === 'fail') ? 1 : 0}\n`);
  writeFileSync(join(at, `${id}.files`), `${[...new Set(o.cases.map(c => c[0]))].join('\n')}\n`);
  const cases = o.cases.map(([file, name, status]) => `<testcase name="${name}" file="${file}"${status === 'fail' ? '><failure message="x"/></testcase>' : '/>'}`).join('');
  writeFileSync(join(at, `${id}.junit.xml`), `<?xml version="1.0"?><testsuites tests="${o.cases.length}"><testsuite name="s" tests="${o.cases.length}">${cases}</testsuite></testsuites>`);
}

function withRepo(fn: (dir: string, sha: string, record: (manifest: unknown, attempt?: number) => { tree: Record<string, unknown>; stdout: string }) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-rerun-evidence-'));
  try {
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'a');
    const sha = git('rev-parse', 'HEAD').stdout.trim();
    const record = (manifest: unknown, attempt = (manifest as { run_attempt: number }).run_attempt) => {
      const path = join(dir, 'ci-manifest.json');
      writeFileSync(path, JSON.stringify(manifest));
      const out = join(dir, 'out');
      const result = spawnSync('bash', [join(root, 'scripts/ci-full-suite-tree.sh')], {
        cwd: dir, encoding: 'utf8',
        env: { ...process.env, ARTIFACT_DIR: out, RUN_ID: String(RUN), RUN_ATTEMPT: String(attempt), WORKFLOW: 'Test', EVENT: 'workflow_dispatch', MANIFEST: path, EXECUTED_RECEIPTS: 'success', GITHUB_STEP_SUMMARY: join(dir, 'summary.md') },
      });
      expect(result.status, result.stderr).toBe(0);
      return { tree: JSON.parse(readFileSync(join(out, 'tree.json'), 'utf8')), stdout: result.stdout };
    };
    fn(dir, sha, record);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bind = (sha: string, attempt: number) => ({ workflow: 'Test', event: 'workflow_dispatch', sha, run_id: RUN, run_attempt: attempt });

describe('a rerun of only the failed jobs keeps complete, honest run evidence', () => {
  test('the manifest and tree.json cover every file across attempts and mark the rerun job\'s files as rerun, never as a clean pass', () => {
    withRepo((dir, sha, record) => {
      const r = join(dir, 'receipts');
      receipts(r, 'receipts-unit-1', { shard: 1, of: 2, attempt: 1, sha, cases: [['test/a.test.ts', 'a1', 'pass'], ['test/a.test.ts', 'a2', 'pass']] });
      receipts(r, 'receipts-unit-2', { shard: 2, of: 2, attempt: 2, sha, cases: [['test/b.test.ts', 'b1', 'pass'], ['test/c.test.ts', 'c1', 'pass']] });
      const m = buildManifest(loadReceiptDir(r), bind(sha, 2));
      const { tree, stdout } = record(m);
      expect(stdout).not.toContain('::warning::');
      expect(tree.files).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts']);
      expect(tree.tests).toBe(4);
      expect(tree.rerun_files).toEqual(['test/b.test.ts', 'test/c.test.ts']);
      expect(tree.attempts).toEqual([1, 2]);
      expect(tree.run_attempt).toBe(2);
      expect(m.problems).toEqual([]);
      expect(m.complete).toBe(true);
      expect(m.attempts).toEqual([1, 2]);
      expect(m.files).toEqual([
        { file: 'test/a.test.ts', lane: 'unit', arm: '', executed: 2, failed: 0, skipped: 0 },
        { file: 'test/b.test.ts', lane: 'unit', arm: '', executed: 1, failed: 0, skipped: 0, rerun: true },
        { file: 'test/c.test.ts', lane: 'unit', arm: '', executed: 1, failed: 0, skipped: 0, rerun: true },
      ]);
      expect([...passedFiles(m)]).toEqual(['test/a.test.ts']);
      expect(rerunProblem(m)).toBe(`run ${RUN} attempt 2 re-ran only failed jobs (attempts 1, 2); 2 file(s) passed only on that re-run (test/b.test.ts, test/c.test.ts), so the run cannot clear a failure`);
    });
  });

  test('a re-run of only full-suite keeps the earlier attempt\'s manifest as evidence (GST-3429)', () => {
    withRepo((dir, sha, record) => {
      const r = join(dir, 'receipts');
      receipts(r, 'receipts-unit-1', { shard: 1, of: 2, attempt: 1, sha, cases: [['test/a.test.ts', 'a1', 'pass']] });
      receipts(r, 'receipts-unit-2', { shard: 2, of: 2, attempt: 1, sha, cases: [['test/b.test.ts', 'b1', 'pass']] });
      const m = buildManifest(loadReceiptDir(r), bind(sha, 1));
      expect(m.complete).toBe(true);
      const { tree, stdout } = record(m, 2);
      expect(stdout).not.toContain('::warning::');
      expect(tree.run_attempt).toBe(2);
      expect(tree.files).toEqual(['test/a.test.ts', 'test/b.test.ts']);
      expect(tree.tests).toBe(2);
      expect(tree.rerun_files).toBeUndefined();
      const newer = record(m, 0);
      expect(newer.tree.files).toBeUndefined();
      expect(newer.stdout).toContain(`ci-manifest.json belongs to run ${RUN} attempt 1, newer than this attempt 0`);
    });
  });

  test('a run where every job ran in one attempt records no rerun', () => {
    withRepo((dir, sha, record) => {
      const r = join(dir, 'receipts');
      receipts(r, 'receipts-unit-1', { shard: 1, of: 2, attempt: 2, sha, cases: [['test/a.test.ts', 'a1', 'pass']] });
      receipts(r, 'receipts-unit-2', { shard: 2, of: 2, attempt: 2, sha, cases: [['test/b.test.ts', 'b1', 'pass']] });
      const m = buildManifest(loadReceiptDir(r), bind(sha, 2));
      expect(m.complete).toBe(true);
      expect(m.attempts).toEqual([2]);
      expect(m.files.some(f => f.rerun)).toBe(false);
      expect(rerunProblem(m)).toBeUndefined();
      const { tree } = record(m);
      expect(tree.files).toEqual(['test/a.test.ts', 'test/b.test.ts']);
      expect(tree.rerun_files).toBeUndefined();
      expect(tree.attempts).toBeUndefined();
    });
  });

  test('a failing job that was not re-run green, or whose re-run left its failing receipts behind, is never evidence', () => {
    withRepo((dir, sha, record) => {
      const r = join(dir, 'receipts');
      receipts(r, 'receipts-unit-1', { shard: 1, of: 2, attempt: 1, sha, cases: [['test/a.test.ts', 'a1', 'pass']] });
      receipts(r, 'receipts-unit-2', { shard: 2, of: 2, attempt: 1, sha, cases: [['test/b.test.ts', 'b1', 'fail']] });
      for (const attempt of [1, 2]) {
        const m = buildManifest(loadReceiptDir(r), bind(sha, attempt));
        expect(m.failures.map(f => f.file)).toEqual(['test/b.test.ts']);
        expect([...passedFiles(m)]).toEqual(['test/a.test.ts']);
        const { tree, stdout } = record(m);
        expect(tree.files).toBeUndefined();
        expect(stdout).toContain('::warning::tree.json records no executed test files: ci-manifest.json lists 1 failing test(s) in the newest attempt of each job');
      }
    });
  });
});
