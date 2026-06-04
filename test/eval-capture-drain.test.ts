/**
 * v0.42.20.0 (#1762) — eval-capture is the 4th fire-and-forget DB-write sink the
 * background-work registry drains before CLI disconnect. `captureEvalCandidate`
 * is `void`-ed by the search/query op handlers; its async `logEvalCandidate`
 * write is the same lock-pin / disconnect-race class as the other sinks. These
 * tests pin the bounded drain (`awaitPendingEvalCaptures`).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  captureEvalCandidate,
  awaitPendingEvalCaptures,
  _resetPendingEvalCapturesForTests,
  type CaptureContext,
} from '../src/core/eval-capture.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';

function makeCtx(): CaptureContext {
  const result: SearchResult = {
    slug: 'people/alice-example',
    page_id: 1,
    title: 'Alice Example',
    type: 'person',
    chunk_text: '…',
    chunk_source: 'compiled_truth',
    chunk_id: 42,
    chunk_index: 0,
    score: 0.9,
    stale: false,
    source_id: 'default',
  };
  return {
    tool_name: 'query',
    query: 'who is alice',
    results: [result],
    meta: { vector_enabled: true, detail_resolved: 'medium', expansion_applied: false },
    latency_ms: 1,
    remote: false,
    expand_enabled: false,
    detail: null,
    job_id: null,
    subagent_id: null,
  };
}

afterEach(() => _resetPendingEvalCapturesForTests());

describe('awaitPendingEvalCaptures', () => {
  test('empty set drains instantly', async () => {
    const r = await awaitPendingEvalCaptures(50);
    expect(r.unfinished).toBe(0);
  });

  test('drains a settled capture to unfinished:0', async () => {
    const engine = {
      logEvalCandidate: async () => 1,
      logEvalCaptureFailure: async () => {},
    } as unknown as BrainEngine;
    void captureEvalCandidate(engine, makeCtx(), { scrub_pii: false });
    const r = await awaitPendingEvalCaptures(1000);
    expect(r.unfinished).toBe(0);
  });

  test('a hanging capture is bounded by the timeout (not a hang)', async () => {
    const engine = {
      // Never resolves — simulates a wedged DB write.
      logEvalCandidate: () => new Promise<number>(() => {}),
      logEvalCaptureFailure: async () => {},
    } as unknown as BrainEngine;
    void captureEvalCandidate(engine, makeCtx(), { scrub_pii: false });
    const start = Date.now();
    const r = await awaitPendingEvalCaptures(150);
    const elapsed = Date.now() - start;
    expect(r.unfinished).toBe(1);
    expect(elapsed).toBeLessThan(1000);
  });
});
