import { describe, expect, test } from 'bun:test';
import { extractionCompletedForFidelity } from '../src/core/cycle/extraction-completion.ts';
import type { PhaseResult } from '../src/core/cycle.ts';

const committed = { request_id: '11111111-2222-4333-8444-555555555555', state: 'committed', retry_after_ms: null };
const ready: PhaseResult = {
  phase: 'extract_atoms', status: 'ok', summary: '', duration_ms: 0,
  details: {
    dry_run: false, budget_exhausted: false, failures: [], pages_processed: 1, pages_total: 1,
    transcripts_processed: 0, transcripts_total: 0, transcripts_skipped_budget: 0, pages_skipped_budget: 0,
    write_pending: 0, held_failed: 0, input_truncated: 0, malformed_outputs: 0, stopped_outputs: 0,
    write_requests: [committed],
  },
};

describe('fidelity extraction completion', () => {
  test('accepts completed scoped work with terminal receipts', () => {
    expect(extractionCompletedForFidelity(ready)).toBe(true);
  });

  test.each([
    { dry_run: true },
    { pages_processed: 0 },
    { pages_skipped_budget: 1 },
    { input_truncated: 1 },
    { stopped_outputs: 1 },
    { failures: ['rejected input'] },
    { write_requests: [{ ...committed, state: 'queued', retry_after_ms: 1000 }] },
    { source_routing: { generation_members_held: { source_not_ready: 1 } } },
  ])('rejects an incomplete or held batch with details %j', (details) => {
    expect(extractionCompletedForFidelity({ ...ready, details: { ...ready.details, ...details } })).toBe(false);
  });
});
