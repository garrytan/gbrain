/**
 * #4610 — an ADOPTED CRAG escalation honors the caller's `limit`.
 *
 * The escalated re-run is deliberately wide (limit >= 50, autocut off) so a
 * better rank-1 can enter the sweep — but `limit` is the caller's row
 * contract. Pre-fix, `results = escalated` handed the whole uncut sweep back
 * (14-18 rows for a limit:10 request in the issue's measurements), and
 * bumpLastRetrievedAt + eval capture recorded the oversized set.
 *
 * Serial file: mock.module on hybrid.ts (R2 quarantine rule — the mock
 * patches live bindings process-wide, so this file gets its own bun process
 * via the *.serial.test.ts lane). The mock swaps ONLY hybridSearchCached;
 * everything else (the query op handler, CRAG grading, the adoption swap)
 * is production code against a hermetic PGLite engine.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import type { SearchResult } from '../../src/core/types.ts';

const HYBRID_PATH = '../../src/core/search/hybrid.ts';
const actualHybrid = await import(HYBRID_PATH);

function row(i: number, rerankScore: number): SearchResult {
  return {
    slug: `notes/n${i}`,
    page_id: 900000 + i,
    title: `n${i}`,
    type: 'note',
    chunk_text: `chunk ${i}`,
    chunk_source: 'compiled_truth',
    chunk_id: i,
    chunk_index: 0,
    score: 1 - i * 0.01,
    stale: false,
    rerank_score: rerankScore,
  } as SearchResult;
}

// Call log: one entry per hybridSearchCached invocation with the opts we
// need to pin (limit + autocut identify the escalated re-run).
const calls: Array<{ limit: unknown; autocut: unknown }> = [];

mock.module(HYBRID_PATH, () => ({
  ...actualHybrid,
  hybridSearchCached: async (
    _engine: unknown,
    _query: string,
    opts: { limit?: number; autocut?: boolean },
  ): Promise<SearchResult[]> => {
    calls.push({ limit: opts?.limit, autocut: opts?.autocut });
    if (opts?.autocut === false) {
      // The escalated high-ceiling sweep: 30 rows, strong rank-1.
      return Array.from({ length: 30 }, (_, i) => row(100 + i, i === 0 ? 0.9 : 0.05));
    }
    // First pass: 10 rows, weak rank-1 (rerank_top_below_floor).
    return Array.from({ length: 10 }, (_, i) => row(i, 0.05));
  },
}));

const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { operationsByName } = await import('../../src/core/operations.ts');
type OperationContext = import('../../src/core/operations.ts').OperationContext;

let engine: InstanceType<typeof PGLiteEngine>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('search.crag_escalation', 'true');
});

afterAll(async () => {
  await engine.disconnect();
});

describe('#4610 query op — adopted escalation is sliced to the caller limit', () => {
  test('limit:10 caller gets exactly 10 rows from the adopted 30-row sweep', async () => {
    calls.length = 0;
    const meta: Record<string, unknown> = {};
    const ctx = {
      engine,
      remote: false,
      sourceId: 'default',
      emitResponseMeta: (key: string, value: unknown) => { meta[key] = value; },
    } as unknown as OperationContext;

    const results = (await operationsByName.query.handler(ctx, {
      query: 'sprocket subsystem retries',
      limit: 10,
      // #4610 guard: escalation only fires when the first pass did NOT
      // already use the expansion knob.
      expand: false,
    })) as SearchResult[];

    // The escalated re-run fired with the wide ceiling…
    expect(calls.length).toBe(2);
    expect(calls[1].limit).toBe(50);
    expect(calls[1].autocut).toBe(false);

    // …was adopted (strong beats weak; rank-1 comes from the sweep)…
    const crag = (meta.retrieval as { crag: { escalated?: boolean; confidence: string } }).crag;
    expect(crag.escalated).toBe(true);
    expect(crag.confidence).toBe('strong');
    expect(results[0].slug).toBe('notes/n100');

    // …and the caller-visible set honors the limit contract (pre-fix: 30).
    expect(results.length).toBe(10);
  }, 30000);
});
