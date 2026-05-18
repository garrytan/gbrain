/**
 * PGLite round-trip for the 5 eval-capture engine methods shipped in v0.21.0:
 *   logEvalCandidate / listEvalCandidates / deleteEvalCandidatesBefore
 *   logEvalCaptureFailure / listEvalCaptureFailures
 *
 * No Docker, no DATABASE_URL. In-memory only. For Postgres-only behavior
 * (RLS policy enforcement, CHECK violation error codes, concurrent pool
 * pressure), see test/e2e/eval-capture.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { EvalCandidateInput, EvalCaptureFailureReason } from '../src/core/types.ts';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.exec('DELETE FROM eval_candidates');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.exec('DELETE FROM eval_capture_failures');
});

function makeInput(overrides: Partial<EvalCandidateInput> = {}): EvalCandidateInput {
  return {
    tool_name: 'query',
    query: 'who is alice-example',
    retrieved_slugs: ['people/alice-example', 'companies/acme-example'],
    retrieved_chunk_ids: [42, 43],
    source_ids: ['default'],
    expand_enabled: true,
    detail: null,
    detail_resolved: 'medium',
    vector_enabled: true,
    expansion_applied: false,
    latency_ms: 123,
    remote: true,
    job_id: null,
    subagent_id: null,
    ...overrides,
  };
}

describe('logEvalCandidate', () => {
  test('inserts a full row and returns the id', async () => {
    const id = await engine.logEvalCandidate(makeInput());
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('preserves array + enum + boolean columns through round-trip', async () => {
    await engine.logEvalCandidate(
      makeInput({
        tool_name: 'search',
        expand_enabled: null, // search has no expansion semantics
        detail: 'high',
        detail_resolved: 'high',
        vector_enabled: false,
        expansion_applied: false,
        job_id: 9001,
        subagent_id: 42,
        remote: false,
      }),
    );
    const rows = await engine.listEvalCandidates();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tool_name).toBe('search');
    expect(row.retrieved_slugs).toEqual(['people/alice-example', 'companies/acme-example']);
    expect(row.retrieved_chunk_ids).toEqual([42, 43]);
    expect(row.source_ids).toEqual(['default']);
    expect(row.expand_enabled).toBeNull();
    expect(row.detail).toBe('high');
    expect(row.detail_resolved).toBe('high');
    expect(row.vector_enabled).toBe(false);
    expect(row.job_id).toBe(9001);
    expect(row.subagent_id).toBe(42);
    expect(row.remote).toBe(false);
  });

  test('rejects oversize queries via CHECK constraint (50KB cap)', async () => {
    const bigQuery = 'x'.repeat(51201);
    await expect(engine.logEvalCandidate(makeInput({ query: bigQuery }))).rejects.toThrow();
  });

  test('rejects invalid tool_name via CHECK constraint', async () => {
    await expect(
      engine.logEvalCandidate(makeInput({ tool_name: 'dance' as unknown as 'query' })),
    ).rejects.toThrow();
  });
});

describe('listEvalCandidates', () => {
  test('returns empty when table is empty', async () => {
    expect(await engine.listEvalCandidates()).toEqual([]);
  });

  test('filters by tool', async () => {
    await engine.logEvalCandidate(makeInput({ tool_name: 'query' }));
    await engine.logEvalCandidate(makeInput({ tool_name: 'search', expand_enabled: null }));
    await engine.logEvalCandidate(makeInput({ tool_name: 'query' }));

    const queries = await engine.listEvalCandidates({ tool: 'query' });
    const searches = await engine.listEvalCandidates({ tool: 'search' });

    expect(queries).toHaveLength(2);
    expect(searches).toHaveLength(1);
    expect(queries.every(r => r.tool_name === 'query')).toBe(true);
    expect(searches.every(r => r.tool_name === 'search')).toBe(true);
  });

  test('filters by since (inclusive lower bound)', async () => {
    await engine.logEvalCandidate(makeInput());
    const cutoff = new Date(Date.now() + 60_000); // 1 minute in future — excludes everything
    expect(await engine.listEvalCandidates({ since: cutoff })).toHaveLength(0);

    const past = new Date(0);
    expect(await engine.listEvalCandidates({ since: past })).toHaveLength(1);
  });

  test('honors limit and returns newest-first (id DESC tiebreaker for same-ms inserts)', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await engine.logEvalCandidate(makeInput({ query: `q${i}` })));
    }
    const limited = await engine.listEvalCandidates({ limit: 3 });
    expect(limited).toHaveLength(3);
    // ORDER BY created_at DESC, id DESC — same-millisecond rows fall back to
    // id DESC, which matches insertion order. Critical for `gbrain eval export`
    // since unstable tiebreaks would cause duplicate/missed rows across runs.
    expect(limited.map(r => r.id)).toEqual([ids[4]!, ids[3]!, ids[2]!]);
  });

  test('clamps limit to [1, 100000]', async () => {
    await engine.logEvalCandidate(makeInput());
    // Implementation must clamp limit <= 0 up to default and cap huge values.
    expect(await engine.listEvalCandidates({ limit: 0 })).toHaveLength(1);
    expect(await engine.listEvalCandidates({ limit: 10_000_000 })).toHaveLength(1);
  });
});

describe('deleteEvalCandidatesBefore', () => {
  test('returns the number of rows deleted', async () => {
    for (let i = 0; i < 3; i++) {
      await engine.logEvalCandidate(makeInput());
    }
    const futureCutoff = new Date(Date.now() + 60_000);
    const deleted = await engine.deleteEvalCandidatesBefore(futureCutoff);
    expect(deleted).toBe(3);
    expect(await engine.listEvalCandidates()).toHaveLength(0);
  });

  test('leaves newer rows alone', async () => {
    await engine.logEvalCandidate(makeInput({ query: 'old' }));
    // Cutoff 0 deletes nothing since created_at > 1970.
    const pastCutoff = new Date(0);
    const deleted = await engine.deleteEvalCandidatesBefore(pastCutoff);
    expect(deleted).toBe(0);
    expect(await engine.listEvalCandidates()).toHaveLength(1);
  });
});

describe('logEvalCaptureFailure / listEvalCaptureFailures', () => {
  test('inserts and round-trips each reason enum', async () => {
    const reasons: EvalCaptureFailureReason[] = [
      'db_down',
      'rls_reject',
      'check_violation',
      'scrubber_exception',
      'other',
    ];
    for (const r of reasons) {
      await engine.logEvalCaptureFailure(r);
    }
    const rows = await engine.listEvalCaptureFailures();
    expect(rows.map(r => r.reason).sort()).toEqual([...reasons].sort());
  });

  test('rejects invalid reason via CHECK constraint', async () => {
    await expect(
      engine.logEvalCaptureFailure('unknown' as EvalCaptureFailureReason),
    ).rejects.toThrow();
  });

  test('filters by since', async () => {
    await engine.logEvalCaptureFailure('db_down');
    const future = new Date(Date.now() + 60_000);
    expect(await engine.listEvalCaptureFailures({ since: future })).toHaveLength(0);
    expect(await engine.listEvalCaptureFailures({ since: new Date(0) })).toHaveLength(1);
  });
});
