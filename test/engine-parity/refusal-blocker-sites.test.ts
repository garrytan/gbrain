/**
 * BrainEngine parity: command and core sites that read through `executeRaw` inside a try/catch and carried on with a
 * quiet default when a Rust brain refused the statement (the silent-read-catches guard's `capability_refusal_swallowed`
 * rule). Each case runs the real caller on every arm: a Rust brain must answer what PGLite answers, not the default.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `gbrain eval whoknows` loads its replay rows (loadReplayRows) as the newest 200 captured `query` calls,
 *    newest first, and a Rust brain returns the same rows.
 *  - Regression: a caller that swallows the Rust refusal returns no rows, so the regression gate reports "skipped:
 *    0 replay-eligible rows" for a brain that has them.
 *  - Why existing coverage misses it: the caller's catch turns the refusal into `[]`, which no engine-level case reads.
 *  - Seam: none. Rows come from logEvalCandidate; ids and timestamps are never returned.
 */
import { describe, expect } from 'bun:test';
import type { EvalCandidateInput } from '../../src/core/types.ts';
import { loadReplayRows } from '../../src/commands/eval-whoknows.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const CANDIDATE: EvalCandidateInput = {
  tool_name: 'query',
  query: 'who runs acme',
  retrieved_slugs: ['people/alice', 'companies/acme'],
  retrieved_chunk_ids: [],
  source_ids: ['default'],
  expand_enabled: true,
  detail: 'medium',
  detail_resolved: 'high',
  vector_enabled: true,
  expansion_applied: false,
  latency_ms: 42,
  remote: false,
  job_id: null,
  subagent_id: null,
  embedding_column: 'embedding',
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('engine parity: refusal-swallow sites (eval whoknows replay)', () => {
  parityTest(
    'eval whoknows replay rows are the newest captured query calls, a search call is not replayed',
    { methods: ['logEvalCandidate'] },
    async (engine) => {
      await engine.logEvalCandidate({ ...CANDIDATE, query: 'first query', retrieved_slugs: ['people/alice'] });
      await delay(20);
      await engine.logEvalCandidate({ ...CANDIDATE, tool_name: 'search', query: 'a search call' });
      await delay(20);
      await engine.logEvalCandidate({ ...CANDIDATE, query: 'second query', retrieved_slugs: [] });
      const rows = await loadReplayRows(engine);
      expect(rows.map((r) => r.query)).toEqual(['second query', 'first query']);
      return rows;
    },
  );
});
