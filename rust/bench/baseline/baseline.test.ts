/**
 * The /ship test lane for the bake-off baseline (rust/bench/baseline) and the corpus script (rust/bench/corpus).
 * It lives outside test/ on purpose: the unit runner only collects test/, and the baseline is a benchmark
 * tool, not shipped code. It type-checks the baseline with its own tsconfig (the root tsconfig does not
 * include it), checks the pure helpers, checks that run.ts refuses bad flags before it opens any store,
 * and checks that the corpus script parses. It never opens a brain and never calls a provider.
 */
import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { parseArgs } from './lib/args.ts';
import { makeRng, median, percentile, summarize } from './lib/stats.ts';

const repo = resolve(import.meta.dir, '../../..');

function run(args: string[]) {
  const result = Bun.spawnSync(args, { cwd: repo, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

describe('bake-off baseline', () => {
  test('the baseline type-checks with its own tsconfig', () => {
    const tsc = run([join(repo, 'node_modules', '.bin', 'tsc'), '--noEmit', '-p', 'rust/bench/baseline/tsconfig.json']);
    if (tsc.code !== 0) console.error(tsc.out);
    expect(tsc.code).toBe(0);
  }, 300_000);

  test('latency summaries use nearest-rank percentiles', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 99)).toBe(10);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
    expect(median([3, 1, 2])).toBe(2);
    expect(summarize([10, 1, 5, 2], 1000, { note: 'x' })).toEqual({ n: 4, p50_ms: 2, p99_ms: 10, ops_per_s: 4, note: 'x' });
  });

  test('the operation sequence is the same for the same seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const c = makeRng(43);
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c()]).not.toEqual(seqA);
    for (const x of seqA) expect(x >= 0 && x < 1).toBe(true);
  });

  test('flags parse to the documented defaults', () => {
    const args = parseArgs(['--engine', 'pglite', '--corpus', '/c', '--scale', '10k', '--out', '/o.json', '--quick'], ['import']);
    expect(args.engine).toBe('pglite');
    expect(args.hnsw).toBe('inline');
    expect(args.limitPages).toBe(500);
    expect(args.dataDir).toBe('/var/tmp/gbrain-bakeoff/pglite-10k-quick');
    expect(args.maxSeconds).toBe(120);
  });

  test('run.ts refuses a bad engine before it opens any store', () => {
    const bad = run([process.execPath, 'rust/bench/baseline/run.ts', '--engine', 'sqlite', '--corpus', '/c', '--scale', '10k', '--out', '/o.json']);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain('--engine must be pglite or postgres');
  }, 60_000);

  test('the corpus script parses', () => {
    const py = run(['python3', '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', 'rust/bench/corpus/dbpedia.py']);
    if (py.code !== 0) console.error(py.out);
    expect(py.code).toBe(0);
  });
});
