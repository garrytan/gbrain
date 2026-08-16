/**
 * test/eval-canary.test.ts — hermetic retrieval canary (deterministic
 * embedder + runner script).
 *
 * Pins:
 *   1. basisEmbedding determinism + dims (src/eval/deterministic-embed.ts).
 *   2. buildQrelsQueryEmbedFn maps fixture queries to their basis dims and
 *      falls back deterministically (FNV-1a-derived dim) for unknown texts.
 *   3. scripts/run-eval-canary.ts end-to-end in check mode: real CLI
 *      subprocess, exit 0, metrics at/above the qrels default floors.
 *   4. Determinism: two in-process runs of the correctness gate through the
 *      queryEmbedFn seam produce identical metrics.
 *   5. Check mode writes nothing to tracked files (git status unchanged).
 *
 * Fully hermetic: no API keys, no network, no DATABASE_URL.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { basisEmbedding, buildQrelsQueryEmbedFn, fnv1a } from '../src/eval/deterministic-embed.ts';
import { parseLegacyQrels, seedCanaryCorpus } from '../scripts/run-eval-canary.ts';
import { runCorrectnessGate, type CorrectnessGateOpts } from '../src/core/bench/correctness-gate.ts';
import { parseQrelsFile, DEFAULT_QRELS_THRESHOLDS } from '../src/core/bench/qrels-file.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';

const ROOT = resolve(import.meta.dir, '..');
const QRELS_PATH = join(ROOT, 'test', 'fixtures', 'eval-baselines', 'qrels-search.json');

// ---------------------------------------------------------------------------
// Canonical PGLite block (CLAUDE.md R3+R4)
// ---------------------------------------------------------------------------

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// ---------------------------------------------------------------------------
// 1. basisEmbedding
// ---------------------------------------------------------------------------

describe('basisEmbedding', () => {
  test('default dim 1536, 1.0 at idx, 0.0 elsewhere', () => {
    const e = basisEmbedding(5);
    expect(e.length).toBe(1536);
    expect(e[5]).toBe(1.0);
    expect(e[0]).toBe(0.0);
    expect(e.reduce((s, v) => s + v, 0)).toBe(1.0);
  });

  test('custom dim + idx wraparound', () => {
    const e = basisEmbedding(103, 100);
    expect(e.length).toBe(100);
    expect(e[3]).toBe(1.0); // 103 % 100
    expect(e.reduce((s, v) => s + v, 0)).toBe(1.0);
  });

  test('deterministic across calls', () => {
    expect([...basisEmbedding(42)]).toEqual([...basisEmbedding(42)]);
  });
});

// ---------------------------------------------------------------------------
// 2. buildQrelsQueryEmbedFn
// ---------------------------------------------------------------------------

describe('buildQrelsQueryEmbedFn', () => {
  const raw = readFileSync(QRELS_PATH, 'utf-8');

  test('maps every fixture query to its embedding_dim basis vector', () => {
    const fn = buildQrelsQueryEmbedFn(raw);
    const fixture = parseLegacyQrels(raw);
    expect(fixture.length).toBeGreaterThanOrEqual(10);
    for (const q of fixture) {
      expect([...fn(q.query)]).toEqual([...basisEmbedding(q.embedding_dim)]);
    }
  });

  test('unknown text falls back to a deterministic FNV-1a-derived dim in [100, 1099]', () => {
    const fn = buildQrelsQueryEmbedFn(raw);
    const unknown = 'a query text that is definitely not in the fixture';
    const a = fn(unknown);
    const b = fn(unknown);
    expect([...a]).toEqual([...b]);
    const idx = a.findIndex(v => v === 1.0);
    expect(idx).toBe(100 + (Math.abs(fnv1a(unknown)) % 1000));
    expect(idx).toBeGreaterThanOrEqual(100);
    expect(idx).toBeLessThanOrEqual(1099);
  });

  test('throws on malformed input', () => {
    expect(() => buildQrelsQueryEmbedFn('not json')).toThrow();
    expect(() => buildQrelsQueryEmbedFn('{"no_queries": true}')).toThrow(/queries/);
  });
});

// ---------------------------------------------------------------------------
// 4. In-process determinism through the queryEmbedFn seam
// ---------------------------------------------------------------------------

describe('correctness gate through the queryEmbedFn seam', () => {
  test('two in-process runs produce identical metrics, at/above the default floors', async () => {
    const raw = readFileSync(QRELS_PATH, 'utf-8');
    await seedCanaryCorpus(engine, parseLegacyQrels(raw));
    const queryEmbedFn = buildQrelsQueryEmbedFn(raw);
    const qrels = parseQrelsFile(raw);
    const searchFn: NonNullable<CorrectnessGateOpts['searchFn']> = async (e, q, o) => {
      const results = await hybridSearch(e, q, { limit: o.limit, queryEmbedFn });
      return results.map(r => ({ source_id: r.source_id, slug: r.slug }));
    };

    const a = await runCorrectnessGate(engine, qrels, { searchFn });
    const b = await runCorrectnessGate(engine, qrels, { searchFn });

    expect(a.summary).toEqual(b.summary);
    expect(a.per_query).toEqual(b.per_query);

    expect(a.summary.queries_errored).toBe(0);
    expect(a.summary.mean_recall_at_k).toBeGreaterThanOrEqual(DEFAULT_QRELS_THRESHOLDS.recall_at_k);
    expect(a.summary.first_relevant_hit_rate).toBeGreaterThanOrEqual(DEFAULT_QRELS_THRESHOLDS.first_relevant_hit);
    expect(a.summary.expected_top1_denominator).toBeGreaterThan(0);
    expect(a.summary.expected_top1_hit_rate).toBeGreaterThanOrEqual(DEFAULT_QRELS_THRESHOLDS.expected_top1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3 + 5. Runner end-to-end (check mode) + tracked-file invariance
// ---------------------------------------------------------------------------

describe('run-eval-canary.ts (check mode)', () => {
  // Captured by the end-to-end test; asserted separately below so a
  // tracked-file write shows up as its own named failure.
  let statusBefore: string | null = null;
  let statusAfter: string | null = null;
  let runExit: number | null = null;

  test('spawns the real CLI gate hermetically and passes the floors', () => {
    // Status scoped to the paths check mode could plausibly touch — a
    // whole-tree porcelain diff flakes when a concurrent shard sibling (or a
    // developer save) creates an unrelated file during the ~30s window.
    const STATUS_SCOPE = 'git status --porcelain -- .gbrain-evals test/fixtures docs/eval';
    statusBefore = execSync(STATUS_SCOPE, { cwd: ROOT, encoding: 'utf-8' });
    const child = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'run-eval-canary.ts')],
      // Outer budget strictly above the runner's inner CLI-child timeout so
      // the runner's own diagnostics always win the race.
      { cwd: ROOT, encoding: 'utf-8', timeout: 118_000 },
    );
    statusAfter = execSync(STATUS_SCOPE, { cwd: ROOT, encoding: 'utf-8' });
    runExit = child.status;

    const combined = (child.stdout ?? '') + (child.stderr ?? '');
    expect(child.status).toBe(0);

    const m = combined.match(
      /mean_recall_at_k=([\d.]+) first_relevant_hit_rate=([\d.]+) expected_top1_hit_rate=([\d.]+)/,
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(DEFAULT_QRELS_THRESHOLDS.recall_at_k);
    expect(Number(m![2])).toBeGreaterThanOrEqual(DEFAULT_QRELS_THRESHOLDS.first_relevant_hit);
    expect(Number(m![3])).toBeGreaterThanOrEqual(DEFAULT_QRELS_THRESHOLDS.expected_top1);
  }, 120_000);

  test('check mode writes nothing to tracked files (git status unchanged)', () => {
    // Guard: the end-to-end test above must have actually run + passed spawn.
    expect(runExit).toBe(0);
    expect(statusBefore).not.toBeNull();
    expect(statusAfter).toBe(statusBefore!);
  });
});
