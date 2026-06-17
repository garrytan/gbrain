/**
 * Tests for `gbrain eval replay` (v0.25.0).
 *
 * Three layers:
 *   1. Pure: Jaccard math + NDJSON parser via re-export.
 *   2. CLI happy path: --against captures NDJSON → human/JSON output.
 *   3. CLI failure: missing file, bad NDJSON, mismatched schema_version.
 */

import { describe, test, expect } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEvalReplay } from '../src/commands/eval-replay.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';

// Minimal stub engine — only the methods replayRow touches matter.
// Every other method is a thrower so accidental use surfaces in tests.
function makeStubEngine(returns: Record<string, SearchResult[]>): BrainEngine {
  return {
    kind: 'pglite',
    searchKeyword: async (q: string) => returns[q] ?? [],
    searchVector: async () => [],
  } as unknown as BrainEngine;
}

function fakeResult(slug: string, score = 0.5): SearchResult {
  return {
    slug,
    chunk_id: 1,
    chunk_index: 0,
    chunk_text: '',
    score,
    title: slug,
    page_kind: 'markdown',
    source_id: 'default',
  } as unknown as SearchResult;
}

function makeCapturedRow(over: Partial<{
  id: number;
  tool_name: 'query' | 'search';
  query: string;
  retrieved_slugs: string[];
  detail: 'low' | 'medium' | 'high' | null;
  expand_enabled: boolean | null;
  latency_ms: number;
}>) {
  return {
    schema_version: 1,
    id: over.id ?? 1,
    tool_name: over.tool_name ?? 'search',
    query: over.query ?? 'alice',
    retrieved_slugs: over.retrieved_slugs ?? ['people/alice', 'people/alice-bio'],
    retrieved_chunk_ids: [],
    source_ids: [],
    expand_enabled: over.expand_enabled ?? null,
    detail: over.detail ?? null,
    detail_resolved: null,
    vector_enabled: false,
    expansion_applied: false,
    latency_ms: over.latency_ms ?? 50,
    remote: true,
    job_id: null,
    subagent_id: null,
    created_at: '2026-04-25T00:00:00Z',
  };
}

function withTmp<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'eval-replay-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function captureStdoutStderr(): { restore: () => { stdout: string; stderr: string } } {
  // Bun's console.log doesn't route through process.stdout.write — it uses
  // internal writers. Hook console directly so test capture works across
  // console.log/error/warn AND raw stream writes.
  let outBuf = '';
  let errBuf = '';
  const origLog = console.log;
  const origErrCons = console.error;
  const origWarn = console.warn;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const stringify = (a: unknown) => typeof a === 'string' ? a : JSON.stringify(a);
  console.log = (...args: unknown[]) => { outBuf += args.map(stringify).join(' ') + '\n'; };
  console.error = (...args: unknown[]) => { errBuf += args.map(stringify).join(' ') + '\n'; };
  console.warn = (...args: unknown[]) => { errBuf += args.map(stringify).join(' ') + '\n'; };
  process.stdout.write = ((s: string | Uint8Array) => {
    outBuf += typeof s === 'string' ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    errBuf += typeof s === 'string' ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      console.log = origLog;
      console.error = origErrCons;
      console.warn = origWarn;
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      return { stdout: outBuf, stderr: errBuf };
    },
  };
}

describe('gbrain eval replay — happy path', () => {
  test('search row with identical retrieved slugs reports Jaccard 1.0', async () => {
    await withTmp(async (dir) => {
      const ndjson = JSON.stringify(makeCapturedRow({
        tool_name: 'search',
        query: 'alice',
        retrieved_slugs: ['people/alice', 'people/alice-bio'],
      })) + '\n';
      const file = join(dir, 'baseline.ndjson');
      writeFileSync(file, ndjson);

      const engine = makeStubEngine({
        alice: [fakeResult('people/alice'), fakeResult('people/alice-bio')],
      });

      const cap = captureStdoutStderr();
      await runEvalReplay(engine, ['--against', file, '--json']);
      const { stdout } = cap.restore();
      const out = JSON.parse(stdout);
      expect(out.schema_version).toBe(1);
      expect(out.summary.rows_replayed).toBe(1);
      expect(out.summary.mean_jaccard).toBe(1.0);
      expect(out.summary.top1_stability_rate).toBe(1.0);
    });
  });

  test('search row with disjoint retrieved slugs reports Jaccard 0', async () => {
    await withTmp(async (dir) => {
      const ndjson = JSON.stringify(makeCapturedRow({
        tool_name: 'search',
        query: 'bob',
        retrieved_slugs: ['people/bob', 'people/bob-bio'],
      })) + '\n';
      const file = join(dir, 'baseline.ndjson');
      writeFileSync(file, ndjson);

      const engine = makeStubEngine({
        bob: [fakeResult('people/charlie'), fakeResult('people/charlie-bio')],
      });

      const cap = captureStdoutStderr();
      await runEvalReplay(engine, ['--against', file, '--json']);
      const { stdout } = cap.restore();
      const out = JSON.parse(stdout);
      expect(out.summary.mean_jaccard).toBe(0);
      expect(out.summary.top1_stability_rate).toBe(0);
    });
  });

  test('partial overlap — captured [a,b], current [a,c] → Jaccard 1/3', async () => {
    await withTmp(async (dir) => {
      const ndjson = JSON.stringify(makeCapturedRow({
        retrieved_slugs: ['a', 'b'],
        query: 'q',
      })) + '\n';
      const file = join(dir, 'baseline.ndjson');
      writeFileSync(file, ndjson);

      const engine = makeStubEngine({ q: [fakeResult('a'), fakeResult('c')] });

      const cap = captureStdoutStderr();
      await runEvalReplay(engine, ['--against', file, '--json']);
      const { stdout } = cap.restore();
      const out = JSON.parse(stdout);
      // {a,b} ∩ {a,c} = {a} (1), union {a,b,c} (3) → 1/3
      expect(out.summary.mean_jaccard).toBeCloseTo(1 / 3, 5);
      // top-1 still matches (both lead with 'a')
      expect(out.summary.top1_stability_rate).toBe(1.0);
    });
  });

  test('top-1 mismatch reduces stability rate', async () => {
    await withTmp(async (dir) => {
      const ndjson = JSON.stringify(makeCapturedRow({
        retrieved_slugs: ['a', 'b', 'c'],
        query: 'q',
      })) + '\n';
      const file = join(dir, 'baseline.ndjson');
      writeFileSync(file, ndjson);

      const engine = makeStubEngine({ q: [fakeResult('b'), fakeResult('a'), fakeResult('c')] });

      const cap = captureStdoutStderr();
      await runEvalReplay(engine, ['--against', file, '--json']);
      const { stdout } = cap.restore();
      const out = JSON.parse(stdout);
      // Same set, jaccard = 1.0
      expect(out.summary.mean_jaccard).toBe(1.0);
      // top-1 swapped a → b, stability 0
      expect(out.summary.top1_stability_rate).toBe(0);
    });
  });

  test('multiple rows → averaged Jaccard + top-1 rate', async () => {
    await withTmp(async (dir) => {
      const lines = [
        JSON.stringify(makeCapturedRow({ id: 1, query: 'q1', retrieved_slugs: ['a'] })),
        JSON.stringify(makeCapturedRow({ id: 2, query: 'q2', retrieved_slugs: ['b'] })),
      ].join('\n') + '\n';
      const file = join(dir, 'baseline.ndjson');
      writeFileSync(file, lines);

      const engine = makeStubEngine({
        q1: [fakeResult('a')],            // perfect match
        q2: [fakeResult('z')],            // miss
      });

      const cap = captureStdoutStderr();
      await runEvalReplay(engine, ['--against', file, '--json']);
      const { stdout } = cap.restore();
      const out = JSON.parse(stdout);
      // (1.0 + 0) / 2 = 0.5
      expect(out.summary.mean_jaccard).toBe(0.5);
      // (1 + 0) / 2 = 0.5
      expect(out.summary.top1_stability_rate).toBe(0.5);
      expect(out.summary.rows_replayed).toBe(2);
    });
  });

  test('--limit caps replay count', async () => {
    await withTmp(async (dir) => {
      const lines = [1, 2, 3, 4, 5]
        .map(i => JSON.stringify(makeCapturedRow({ id: i, query: `q${i}`, retrieved_slugs: ['a'] })))
        .join('\n') + '\n';
      const file = join(dir, 'baseline.ndjson');
      writeFileSync(file, lines);

      const engine = makeStubEngine({});  // returns [] for everything

      const cap = captureStdoutStderr();
      await runEvalReplay(engine, ['--against', file, '--limit', '2', '--json']);
      const { stdout } = cap.restore();
      const out = JSON.parse(stdout);
      expect(out.summary.rows_total).toBe(2);
    });
  });

  test('empty query is skipped, not counted in replayed', async () => {
    await withTmp(async (dir) => {
      const ndjson = JSON.stringify(makeCapturedRow({ query: '', retrieved_slugs: [] })) + '\n';
      const file = join(dir, 'baseline.ndjson');
      writeFileSync(file, ndjson);

      const engine = makeStubEngine({});

      const cap = captureStdoutStderr();
      await runEvalReplay(engine, ['--against', file, '--json']);
      const { stdout } = cap.restore();
      const out = JSON.parse(stdout);
      expect(out.summary.rows_skipped).toBe(1);
      expect(out.summary.rows_replayed).toBe(0);
    });
  });

  test('--verbose includes per-row results in JSON', async () => {
    await withTmp(async (dir) => {
      const ndjson = JSON.stringify(makeCapturedRow({ query: 'q', retrieved_slugs: ['a'] })) + '\n';
      const file = join(dir, 'baseline.ndjson');
      writeFileSync(file, ndjson);

      const engine = makeStubEngine({ q: [fakeResult('a')] });

      const cap = captureStdoutStderr();
      await runEvalReplay(engine, ['--against', file, '--json', '--verbose']);
      const { stdout } = cap.restore();
      const out = JSON.parse(stdout);
      expect(Array.isArray(out.results)).toBe(true);
      expect(out.results.length).toBe(1);
      expect(out.results[0].jaccard).toBe(1.0);
      expect(out.results[0].current_slugs).toEqual(['a']);
    });
  });

  test('row that throws during replay → errored, not crash', async () => {
    await withTmp(async (dir) => {
      const ndjson = JSON.stringify(makeCapturedRow({ query: 'boom' })) + '\n';
      const file = join(dir, 'baseline.ndjson');
      writeFileSync(file, ndjson);

      const engine = {
        kind: 'pglite' as const,
        searchKeyword: async () => { throw new Error('engine offline'); },
        searchVector: async () => [],
      } as unknown as BrainEngine;

      const cap = captureStdoutStderr();
      await runEvalReplay(engine, ['--against', file, '--json']);
      const { stdout } = cap.restore();
      const out = JSON.parse(stdout);
      expect(out.summary.rows_errored).toBe(1);
      expect(out.summary.rows_replayed).toBe(0);
    });
  });

  test('human mode prints summary and top regressions', async () => {
    await withTmp(async (dir) => {
      const ndjson = JSON.stringify(makeCapturedRow({ query: 'q', retrieved_slugs: ['a'] })) + '\n';
      const file = join(dir, 'baseline.ndjson');
      writeFileSync(file, ndjson);

      const engine = makeStubEngine({ q: [fakeResult('z')] }); // miss

      const cap = captureStdoutStderr();
      await runEvalReplay(engine, ['--against', file]);
      const { stdout, stderr } = cap.restore();
      expect(stderr).toContain('Replaying 1');
      expect(stdout).toContain('Mean Jaccard@k:');
      expect(stdout).toContain('Top-1 stability:');
      expect(stdout).toContain('regression');
    });
  });
});

describe('gbrain eval replay — failure modes', () => {
  test('missing --against errors and exits 1', async () => {
    const origExit = process.exit;
    let code: number | undefined;
    process.exit = (c?: number) => { code = c; throw new Error('exit'); };
    const cap = captureStdoutStderr();
    try {
      await runEvalReplay({} as BrainEngine, []);
    } catch { /* expected */ }
    cap.restore();
    process.exit = origExit;
    expect(code).toBe(1);
  });

  test('--against pointing at missing file errors and exits 1', async () => {
    const origExit = process.exit;
    let code: number | undefined;
    process.exit = (c?: number) => { code = c; throw new Error('exit'); };
    const cap = captureStdoutStderr();
    try {
      await runEvalReplay({} as BrainEngine, ['--against', '/tmp/nope-' + Date.now() + '.ndjson']);
    } catch { /* expected */ }
    cap.restore();
    process.exit = origExit;
    expect(code).toBe(1);
  });

  test('NDJSON line missing schema_version is rejected', async () => {
    await withTmp(async (dir) => {
      const file = join(dir, 'bad.ndjson');
      writeFileSync(file, '{"id":1,"tool_name":"search","query":"q","retrieved_slugs":[]}\n');
      const origExit = process.exit;
      let code: number | undefined;
      process.exit = (c?: number) => { code = c; throw new Error('exit'); };
      const cap = captureStdoutStderr();
      try {
        await runEvalReplay({} as BrainEngine, ['--against', file]);
      } catch { /* expected */ }
      const { stderr } = cap.restore();
      process.exit = origExit;
      expect(code).toBe(1);
      expect(stderr).toContain('schema_version');
    });
  });

  test('schema_version === 2 (future) is rejected with helpful message', async () => {
    await withTmp(async (dir) => {
      const file = join(dir, 'v2.ndjson');
      writeFileSync(file, '{"schema_version":2,"id":1,"tool_name":"search","query":"q","retrieved_slugs":[],"latency_ms":0}\n');
      const origExit = process.exit;
      let code: number | undefined;
      process.exit = (c?: number) => { code = c; throw new Error('exit'); };
      const cap = captureStdoutStderr();
      try {
        await runEvalReplay({} as BrainEngine, ['--against', file]);
      } catch { /* expected */ }
      const { stderr } = cap.restore();
      process.exit = origExit;
      expect(code).toBe(1);
      expect(stderr.toLowerCase()).toContain('upgrade gbrain');
    });
  });

  test('empty file errors and exits 1', async () => {
    await withTmp(async (dir) => {
      const file = join(dir, 'empty.ndjson');
      writeFileSync(file, '');
      const origExit = process.exit;
      let code: number | undefined;
      process.exit = (c?: number) => { code = c; throw new Error('exit'); };
      const cap = captureStdoutStderr();
      try {
        await runEvalReplay({} as BrainEngine, ['--against', file]);
      } catch { /* expected */ }
      cap.restore();
      process.exit = origExit;
      expect(code).toBe(1);
    });
  });

  test('malformed JSON line is rejected with line number', async () => {
    await withTmp(async (dir) => {
      const file = join(dir, 'bad.ndjson');
      writeFileSync(file, '{"schema_version":1,"id":1}\nthis is not json\n');
      const origExit = process.exit;
      let code: number | undefined;
      process.exit = (c?: number) => { code = c; throw new Error('exit'); };
      const cap = captureStdoutStderr();
      try {
        await runEvalReplay({} as BrainEngine, ['--against', file]);
      } catch { /* expected */ }
      const { stderr } = cap.restore();
      process.exit = origExit;
      expect(code).toBe(1);
      expect(stderr).toContain('line 2');
    });
  });
});
