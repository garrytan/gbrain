/**
 * The /ship test lane for the bake-off baseline (rust/bench/baseline) and the corpus script (rust/bench/corpus).
 * It lives outside test/ on purpose: the unit runner only collects test/, and the baseline is a benchmark
 * tool, not shipped code. It type-checks the baseline with its own tsconfig (the root tsconfig does not
 * include it), checks the pure helpers, checks that run.ts refuses bad flags before it opens any store,
 * and checks that the corpus script parses. It never opens a brain and never calls a provider.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from './lib/args.ts';
import { loadCorpus } from './lib/corpus.ts';
import { makeRng, median, percentile, summarize } from './lib/stats.ts';
import { preparePostgresDatabase } from './lib/store.ts';
import { loadOrComputeTruth } from './lib/truth.ts';

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

  test('the Postgres prep loads the vendored driver before it checks the URL', async () => {
    // The repo vendors postgres.js as '#postgres'; there is no 'postgres' package on a clean install.
    // A bad database name is refused only after the driver import succeeds, and nothing connects.
    await expect(preparePostgresDatabase('postgresql://u@127.0.0.1:1/not-plain', false)).rejects.toThrow(
      /is not a plain identifier/,
    );
  });

  test('the corpus script parses', () => {
    const py = run(['python3', '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', 'rust/bench/corpus/dbpedia.py']);
    if (py.code !== 0) console.error(py.out);
    expect(py.code).toBe(0);
  });
});

/**
 * The cached ground truth must belong to the corpus beside it. Protects: recall numbers computed against the
 * right neighbors when a corpus directory is rebuilt with the same shape. Regression: reusing
 * truth_top10.json because it merely has the right number of rows. Not covered elsewhere: the other tests here
 * never load a corpus. No production seam: it calls the same loader the runner's truth child calls.
 */
describe('exact truth cache', () => {
  const DIMS = 8, CHUNKS = 12, QUERIES = 3;

  function writeCorpus(dir: string, seed: number): void {
    mkdirSync(dir, { recursive: true });
    const rng = makeRng(seed);
    const unit = (): number[] => {
      const v = Array.from({ length: DIMS }, () => rng() - 0.5);
      const norm = Math.hypot(...v);
      return v.map(x => x / norm);
    };
    const vectors = Float32Array.from(Array.from({ length: CHUNKS }, unit).flat());
    const queries = Float32Array.from(Array.from({ length: QUERIES }, unit).flat());
    const pages = Array.from({ length: CHUNKS / 4 }, (_, i) => ({ i, source_id: 'default', slug: `p/${i}`, type: 'note', title: `P${i}`, frontmatter: {}, body: 'b', chunk_start: i * 4, chunk_count: 4 }));
    const chunks = Array.from({ length: CHUNKS }, (_, c) => ({ page: Math.floor(c / 4), idx: c % 4, text: `c${c}` }));
    writeFileSync(join(dir, 'pages.jsonl'), pages.map(p => JSON.stringify(p)).join('\n') + '\n');
    writeFileSync(join(dir, 'chunks.jsonl'), chunks.map(c => JSON.stringify(c)).join('\n') + '\n');
    writeFileSync(join(dir, 'vectors.f32'), vectors);
    writeFileSync(join(dir, 'queries.f32'), queries);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ format: 'gbrain-bench-corpus/1', dims: DIMS, pages: pages.length, chunks: CHUNKS, queries: QUERIES, sources: ['default'] }));
  }

  test('a rebuilt corpus of the same size gets its own truth, not the old cached one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-truth-cache-'));
    try {
      writeCorpus(dir, 1);
      const a = await loadOrComputeTruth(await loadCorpus(dir), QUERIES, true);
      expect(a.source).toBe('computed');
      expect((await loadOrComputeTruth(await loadCorpus(dir), QUERIES, true)).source).toBe('file');

      writeCorpus(dir, 2); // same directory, same shape, different neighbors
      const corpusB = await loadCorpus(dir);
      const b = await loadOrComputeTruth(corpusB, QUERIES, true);
      expect(b.source).toBe('computed');
      expect(b.top10).not.toEqual(a.top10);
      const dot = (r: number, q: number) => corpusB.vectors.slice(r * DIMS, (r + 1) * DIMS).reduce((s, x, d) => s + x * corpusB.queries[q * DIMS + d]!, 0);
      const exact = (q: number) => Array.from({ length: CHUNKS }, (_, r) => r).sort((x, y) => dot(y, q) - dot(x, q)).slice(0, 10);
      expect(b.top10).toEqual(Array.from({ length: QUERIES }, (_, q) => exact(q)));
      expect((await loadOrComputeTruth(corpusB, QUERIES, true)).source).toBe('file');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
