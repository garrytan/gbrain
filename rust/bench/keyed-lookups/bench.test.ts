/**
 * The /ship test lane for the keyed-lookups bench (rust/bench/keyed-lookups/bench.ts and corpus.ts). It lives outside
 * test/ on purpose, like rust/bench/baseline: the bench is a measuring tool, not shipped code. It checks that the
 * corpus, the query set and the vectors are the same on every run (so two arms compare the same work), and that
 * bench.ts refuses a missing addon before it opens any brain. It never opens a brain and never calls a provider.
 */
import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { corpus, DIMS, median, pct, queries, round, vectorFor } from './corpus.ts';

const repo = resolve(import.meta.dir, '../../..');
const BENCH = 'rust/bench/keyed-lookups/bench.ts';

describe('keyed-lookups bench', () => {
  test('the corpus is the same on every call and holds companies, people and notes', () => {
    const a = corpus(300);
    expect(corpus(300)).toEqual(a);
    expect(a).toHaveLength(300);
    expect(new Set(a.map(p => p.slug)).size).toBe(300);
    const kinds = (prefix: string) => a.filter(p => p.slug.startsWith(prefix)).length;
    expect([kinds('companies/'), kinds('people/'), kinds('notes/')]).toEqual([30, 135, 135]);
    // Every page links somewhere, so link extraction has work on every page.
    expect(a.every(p => p.content.includes('[['))).toBe(true);
  });

  test('the queries are fixed for a corpus: exact titles, title words in a question, and topic questions', () => {
    const pages = corpus(300);
    const q = queries(pages, 9);
    expect(queries(pages, 9)).toEqual(q);
    expect(q).toHaveLength(9);
    expect(pages.some(p => p.title === q[0])).toBe(true);
    expect(q[1]!.startsWith('what do we know about ')).toBe(true);
  });

  test('vectors are deterministic unit vectors of the store width', () => {
    const v = vectorFor('acme launch');
    expect(v).toHaveLength(DIMS);
    expect(vectorFor('acme launch')).toEqual(v);
    expect(vectorFor('other text')).not.toEqual(v);
    expect(Math.abs(Math.sqrt(v.reduce((s, x) => s + x * x, 0)) - 1)).toBeLessThan(1e-9);
  });

  test('stats: nearest-rank percentiles and rounding', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(Number.isNaN(pct([], 0.5))).toBe(true);
    // Nearest rank: the zero-based index is ceil(p * N) - 1, so an integer rank must not take the next sample.
    const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(pct(upTo(20), 0.95)).toBe(19);
    expect(pct(upTo(120), 0.95)).toBe(114);
    expect(pct(upTo(10), 0.5)).toBe(5);
    expect(pct(upTo(3), 0)).toBe(1);
    expect(pct(upTo(3), 1)).toBe(3);
    expect(round(1.23456, 2)).toBe(1.23);
  });

  test(`${BENCH} refuses a missing addon before it opens a brain`, () => {
    const result = Bun.spawnSync([process.execPath, join(repo, BENCH), '--pages', '1'], {
      cwd: repo, env: { ...process.env, GBRAIN_RUST_ENGINE_ADDON: '' }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('--addon must name the addon .node file');
  }, 60_000);
});
