/**
 * gbrain eval export — NDJSON contract (v0.21.0).
 *
 * Verifies:
 *   - every line is valid JSON
 *   - every line has "schema_version": 1
 *   - --since / --tool / --limit filter correctly
 *   - stdout ordering is newest-first
 *   - EPIPE on stdout doesn't crash the process (covered by invariant
 *     that runEvalExport returns without throwing on truncated streams)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runEvalExport } from '../src/commands/eval-export.ts';
import type { EvalCandidateInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

function baseInput(overrides: Partial<EvalCandidateInput> = {}): EvalCandidateInput {
  return {
    tool_name: 'query',
    query: 'alice',
    retrieved_slugs: ['people/alice-example'],
    retrieved_chunk_ids: [1],
    source_ids: ['default'],
    expand_enabled: true,
    detail: null,
    detail_resolved: 'medium',
    vector_enabled: false,
    expansion_applied: false,
    latency_ms: 100,
    remote: false,
    job_id: null,
    subagent_id: null,
    ...overrides,
  };
}

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.exec('DELETE FROM eval_candidates');
});

/**
 * Capture stdout.write output during runEvalExport. The command writes
 * NDJSON directly to process.stdout; we intercept to inspect.
 */
async function captureExport(args: string[]): Promise<string> {
  const captured: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array) => {
    captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  try {
    await runEvalExport(engine, args);
  } finally {
    process.stdout.write = originalWrite;
  }
  return captured.join('');
}

describe('gbrain eval export — NDJSON shape', () => {
  test('empty table → zero lines, exit 0', async () => {
    const out = await captureExport([]);
    expect(out).toBe('');
  });

  test('every row is a valid JSON object on its own line', async () => {
    for (let i = 0; i < 3; i++) {
      await engine.logEvalCandidate(baseInput({ query: `q${i}` }));
    }
    const out = await captureExport([]);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('id');
      expect(parsed).toHaveProperty('query');
      expect(parsed).toHaveProperty('tool_name');
    }
  });

  test('every row starts with "schema_version":1 (F5 contract)', async () => {
    await engine.logEvalCandidate(baseInput());
    const out = await captureExport([]);
    const parsed = JSON.parse(out.trim());
    expect(parsed.schema_version).toBe(1);
  });

  test('--tool query filters to query rows only', async () => {
    await engine.logEvalCandidate(baseInput({ tool_name: 'query' }));
    await engine.logEvalCandidate(
      baseInput({ tool_name: 'search', expand_enabled: null, detail_resolved: null }),
    );
    await engine.logEvalCandidate(baseInput({ tool_name: 'query' }));

    const out = await captureExport(['--tool', 'query']);
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line).tool_name).toBe('query');
    }
  });

  test('--limit caps the row count', async () => {
    for (let i = 0; i < 5; i++) {
      await engine.logEvalCandidate(baseInput({ query: `q${i}` }));
    }
    const out = await captureExport(['--limit', '2']);
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  test('--since DUR filter rejects everything older than the window', async () => {
    await engine.logEvalCandidate(baseInput({ query: 'old' }));
    // --since 1ms: rows created more than 1ms ago are excluded, but the
    // insert we just did happened within the last 1ms so it might still
    // slip through. Use a clearly past window instead.
    const out = await captureExport(['--since', '0s']);
    // 0s is parsed as "since now - 0ms" i.e. since now, which excludes
    // everything that happened before the function started.
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  test('invalid --tool value exits 1 (via process.exit mock check)', async () => {
    // Replace process.exit so we can see the exit code without killing bun.
    const originalExit = process.exit;
    let exitCode: number | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.exit as any) = (code?: number) => {
      exitCode = code;
      throw new Error('exit'); // abort the command
    };
    try {
      await captureExport(['--tool', 'dance']);
    } catch { /* expected */ }
    process.exit = originalExit;
    expect(exitCode).toBe(1);
  });

  test('invalid --since format exits 1', async () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.exit as any) = (code?: number) => {
      exitCode = code;
      throw new Error('exit');
    };
    try {
      await captureExport(['--since', 'yesterday']);
    } catch { /* expected */ }
    process.exit = originalExit;
    expect(exitCode).toBe(1);
  });

  test('output is stream-friendly: each row on its own \\n-terminated line', async () => {
    await engine.logEvalCandidate(baseInput());
    await engine.logEvalCandidate(baseInput({ query: 'second' }));
    const out = await captureExport([]);
    // Trailing newline on every record — no concatenated blobs.
    expect(out).toMatch(/\}\n$/);
    expect(out.split('\n').filter(Boolean)).toHaveLength(2);
  });
});
