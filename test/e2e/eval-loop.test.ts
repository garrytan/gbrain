/**
 * e2e LOOP test (v0.41 / eng-D5).
 *
 * Exercises the full capture → export → publish → gate chain in one
 * process against PGLite in-memory. Hermetic — no LLM calls, no Docker,
 * no DATABASE_URL required.
 *
 * Strategy: use `tool_name: 'search'` (bare keyword) for the captured
 * rows so replay calls `engine.searchKeyword()` which doesn't need
 * embeddings. Basis-vector embeddings are seeded for future vector tests
 * but the LOOP-correctness assertions ride the keyword path.
 *
 * 4 cases per the plan:
 *   1. self-gate passes (regression-only path)
 *   2. perturbed-row gate fails with named breach (regression-only path)
 *   3. D3 fail-closed: malformed baseline → exit 1 with breach (not silent pass)
 *   4. Round-trip: published baseline parses back byte-identically
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { ChunkInput, EvalCandidateInput } from '../../src/core/types.ts';
import { buildBaselineFromInput } from '../../src/commands/bench-publish.ts';
import {
  parseBaselineFile,
  serializeBaselineFile,
} from '../../src/core/bench/baseline-file.ts';
import { runEvalGate } from '../../src/commands/eval-gate.ts';

let engine: PGLiteEngine;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

// Capture a search via the real engine.searchKeyword + build an
// EvalCandidateInput row that mirrors what `gbrain eval export` would write.
async function captureSearch(query: string, latency_ms = 100): Promise<EvalCandidateInput> {
  const t0 = Date.now();
  const results = await engine.searchKeyword(query);
  const observed = Date.now() - t0;
  return {
    tool_name: 'search',
    query,
    retrieved_slugs: results.map(r => r.slug),
    retrieved_chunk_ids: results.map(r => r.chunk_id),
    source_ids: ['default'],
    expand_enabled: null,
    detail: null,
    detail_resolved: null,
    vector_enabled: false,
    expansion_applied: false,
    latency_ms: latency_ms || observed,
    remote: false,
    job_id: null,
    subagent_id: null,
  };
}

// process.exit hijacker for tests that exercise the CLI dispatcher.
function withExitCapture<T>(fn: () => Promise<T>): Promise<{ exitCode: number | null; result?: T }> {
  const realExit = process.exit;
  let captured: number | null = null;
  process.exit = ((code?: number) => {
    captured = code ?? 0;
    throw new Error('__test_exit__');
  }) as typeof process.exit;
  return (async () => {
    try {
      const result = await fn();
      return { exitCode: captured, result };
    } catch (e) {
      if (e instanceof Error && e.message === '__test_exit__') {
        return { exitCode: captured };
      }
      throw e;
    } finally {
      process.exit = realExit;
    }
  })();
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed 4 placeholder pages with distinguishable content. Pages chosen
  // so each captured query hits a unique single page → top1 is stable.
  await engine.putPage('people/alice-example', {
    type: 'person',
    title: 'Alice Example',
    compiled_truth: 'Alice is a fintech founder building payments infrastructure for emerging markets.',
    timeline: '2026-01-15: Met Alice at example meetup.',
  });
  await engine.upsertChunks('people/alice-example', [
    {
      chunk_index: 0,
      chunk_text: 'Alice is a fintech founder building payments infrastructure for emerging markets.',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(0),
      token_count: 15,
    },
  ]);

  await engine.putPage('people/bob-example', {
    type: 'person',
    title: 'Bob Example',
    compiled_truth: 'Bob is an AI safety researcher working on alignment.',
    timeline: '2026-02-10: Bob shared alignment paper.',
  });
  await engine.upsertChunks('people/bob-example', [
    {
      chunk_index: 0,
      chunk_text: 'Bob is an AI safety researcher working on alignment.',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(1),
      token_count: 12,
    },
  ]);

  await engine.putPage('companies/widget-co-example', {
    type: 'company',
    title: 'Widget Co Example',
    compiled_truth: 'Widget Co manufactures industrial widgets for healthcare verticals.',
    timeline: '2026-03-01: Widget Co announced Series A.',
  });
  await engine.upsertChunks('companies/widget-co-example', [
    {
      chunk_index: 0,
      chunk_text: 'Widget Co manufactures industrial widgets for healthcare verticals.',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(2),
      token_count: 12,
    },
  ]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('e2e LOOP: capture → publish → gate against self', () => {
  test('case 1: self-gate against just-published baseline returns PASS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-loop-'));
    try {
      // Step 1: capture three search queries against the live brain.
      const captured = await Promise.all([
        captureSearch('fintech'),
        captureSearch('alignment'),
        captureSearch('widgets'),
      ]);
      // Sanity: keyword search returned at least one row for each (else
      // the test corpus isn't seeded properly and the LOOP can't loop).
      for (const c of captured) {
        expect(c.retrieved_slugs.length).toBeGreaterThan(0);
      }

      // Step 2: publish a baseline from the captured rows.
      const baselineFile = buildBaselineFromInput(captured, {
        label: 'e2e-loop-self-test',
      });
      const baselinePath = join(dir, 'self.baseline.ndjson');
      writeFileSync(baselinePath, serializeBaselineFile(baselineFile));

      // Step 3: gate against the baseline. Since the brain hasn't changed,
      // self-replay should produce identical retrieval → jaccard=1.0,
      // top1=1.0 → verdict PASS → exit 0.
      const out = await withExitCapture(() =>
        runEvalGate(engine, ['--baseline', baselinePath, '--json']),
      );
      // Exit 0 is the unwrapped happy path (no process.exit call).
      // Some assertion environments will have null exitCode meaning "did not
      // call process.exit", which is the success path.
      expect(out.exitCode).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('e2e LOOP: perturbed baseline → gate FAILS with named breach', () => {
  test('case 2: perturbed retrieved_slugs → jaccard drops → exit 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-loop-'));
    try {
      const captured = await Promise.all([
        captureSearch('fintech'),
        captureSearch('alignment'),
        captureSearch('widgets'),
      ]);

      // Perturb: invent slugs that the brain WILL NOT return. Replay will
      // see zero overlap → low jaccard → breach.
      const perturbed = captured.map(c => ({
        ...c,
        retrieved_slugs: ['fake/slug-not-in-brain-1', 'fake/slug-not-in-brain-2'],
      }));

      const baselineFile = buildBaselineFromInput(perturbed, {
        label: 'e2e-loop-perturbed',
      });
      const baselinePath = join(dir, 'perturbed.baseline.ndjson');
      writeFileSync(baselinePath, serializeBaselineFile(baselineFile));

      const out = await withExitCapture(() =>
        runEvalGate(engine, ['--baseline', baselinePath]),
      );
      // Perturbed baseline → current retrieval doesn't match → jaccard well
      // below 0.85 → exit 1 with breach.
      expect(out.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('e2e LOOP: D3 fail-closed on malformed baseline (NOT silent pass)', () => {
  test('case 3: malformed baseline → exit 1 with parse breach (D3 IRON-RULE)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-loop-'));
    try {
      const baselinePath = join(dir, 'bad.baseline.ndjson');
      writeFileSync(baselinePath, '{this is not valid JSON\n');

      const out = await withExitCapture(() =>
        runEvalGate(engine, ['--baseline', baselinePath]),
      );
      // The IRON-RULE: malformed input MUST exit 1 (treat as gate fail).
      // The pre-D3 bug would have silently exited 0.
      expect(out.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('e2e LOOP: round-trip byte stability', () => {
  test('case 4: published baseline parses back byte-identically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-loop-'));
    try {
      const captured = await Promise.all([
        captureSearch('fintech'),
        captureSearch('alignment'),
      ]);

      const baselineFile = buildBaselineFromInput(captured, {
        label: 'roundtrip',
        publishedAt: new Date('2026-05-24T00:00:00Z'),
      });
      const baselinePath = join(dir, 'roundtrip.baseline.ndjson');
      const serialized = serializeBaselineFile(baselineFile);
      writeFileSync(baselinePath, serialized);

      // Read back from disk, parse, re-serialize: must be byte-identical.
      const onDisk = readFileSync(baselinePath, 'utf-8');
      const parsed = parseBaselineFile(onDisk);
      const reserialized = serializeBaselineFile(parsed);
      expect(reserialized).toBe(onDisk);

      // Also: metadata fields preserved exactly.
      expect(parsed.metadata.label).toBe('roundtrip');
      expect(parsed.metadata.published_at).toBe('2026-05-24T00:00:00.000Z');
      expect(parsed.metadata._kind).toBe('baseline_metadata');
      expect(parsed.rows.length).toBe(captured.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
