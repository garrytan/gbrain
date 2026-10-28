/**
 * GBRA-200 (harness ask 6): the degraded stamp is one pure derivation over a
 * call's result, its response meta and the notices it produced. One case per
 * degradation class, the clean result (no stamp), and the CLI placement.
 */
import { describe, expect, test } from 'bun:test';
import type { Notice } from '../src/core/agent-output.ts';
import { DEGRADED_STAMP_PREFIX, degradedStampFor, degradedStampLine } from '../src/core/degraded-stamp.ts';
import { withDegradedStamp } from '../src/cli/op-notices.ts';

const reasons = (op: string, result: unknown, meta: Record<string, unknown> | null = null, notices: Notice[] = []) =>
  degradedStampFor(op, result, meta, notices)?.reasons ?? null;
const retrieval = (degraded: Array<{ stage: string; reason?: string }>, extra: Record<string, unknown> = {}) => ({ retrieval: { degraded, ...extra } });
const notice = (code: string, kind: Notice['kind'] = 'degraded'): Notice => ({ code, kind, why: 'w' });

describe('clean results carry no stamp', () => {
  test('search with an empty stage list, recall without degraded fields, a plain page', () => {
    expect(reasons('search', [{ slug: 'a' }], retrieval([]))).toBeNull();
    expect(reasons('search', [], null)).toBeNull();
    expect(reasons('recall', { facts: [], results: [], total: 0 }, null)).toBeNull();
    expect(reasons('get_page', { slug: 'a', compiled_truth: 'x' })).toBeNull();
    expect(reasons('think', { warnings: ['WINDOW_FROM_QUESTION', 'LLM_OUTPUT_TRUNCATED'] })).toBeNull();
  });

  test('a ranking-only stage is not a degraded result', () => {
    expect(reasons('search', [{ slug: 'a' }], retrieval([{ stage: 'reranker_skipped', reason: 'no_key' }]))).toBeNull();
  });

  test('info notices and degraded notices about something other than this result do not stamp', () => {
    expect(reasons('search', [], retrieval([]), [notice('search_filter_hint', 'info'), notice('no_worker'), notice('write_capacity_backpressure')])).toBeNull();
  });

  test('search_exact paging (the caller\'s limit) is not degradation', () => {
    expect(reasons('search_exact', { complete: false, incomplete_reasons: ['limit'] })).toBeNull();
  });
});

describe('every degradation class stamps with a stable code', () => {
  test('provider down and embed timeout (search, query, recall, find_experts)', () => {
    for (const op of ['search', 'query', 'recall', 'find_experts']) {
      expect(reasons(op, [], retrieval([{ stage: 'embed_unavailable', reason: 'provider_error' }]))).toEqual(['embed_unavailable']);
      expect(reasons(op, [], retrieval([{ stage: 'embed_timeout', reason: 'timeout' }]))).toEqual(['embed_timeout']);
    }
  });

  test('the keyword rank bound and a failed or cut arm', () => {
    expect(reasons('search', [], retrieval([{ stage: 'keyword_candidates_incomplete', reason: 'candidate_budget' }, { stage: 'vector_arm_failed' }])))
      .toEqual(['keyword_candidates_incomplete', 'vector_arm_failed']);
    expect(reasons('query', [], retrieval([{ stage: 'vector_candidates_incomplete', reason: 'timeout' }]))).toEqual(['vector_candidates_incomplete']);
  });

  test('projection_pending stamps only when a pending page could match (the coverage rule)', () => {
    expect(reasons('search', [], retrieval([{ stage: 'projection_pending' }], { coverage: { pending_projection: 4, could_affect: { pending_projection: 0 } } }))).toBeNull();
    expect(reasons('search', [], retrieval([{ stage: 'projection_pending' }], { coverage: { pending_projection: 4, could_affect: { pending_projection: 2 } } }))).toEqual(['projection_pending']);
    expect(reasons('search', [], retrieval([{ stage: 'projection_pending' }]))).toEqual(['projection_pending']);
  });

  test('recall keyword-only markers and question ranking name the same condition as search', () => {
    expect(reasons('recall', { search_degraded: 'keyword_only_no_embedding_provider' })).toEqual(['embed_unavailable']);
    expect(reasons('recall', { search_degraded: 'keyword_only_embedding_disabled' })).toEqual(['embed_unavailable']);
    expect(reasons('recall', { facts_degraded: { reason: 'keyword_only_embedding_disabled' } })).toEqual(['embed_unavailable']);
    expect(reasons('recall', { facts_degraded: { reason: 'embed_timeout', unembedded: 3 } })).toEqual(['embed_timeout', 'facts_unembedded']);
    expect(reasons('recall', { facts_degraded: { reason: 'facts_read_failed' } })).toEqual(['facts_read_failed']);
  });

  test('context_pack deadline and budget, delta incomplete', () => {
    expect(reasons('context_pack', { text: '', degraded_reason: 'deadline' })).toEqual(['deadline']);
    expect(reasons('context_pack', { text: '', degraded_reason: 'budget_trimmed' })).toEqual(['budget_trimmed']);
    expect(reasons('delta', { degraded_reason: 'deadline,threads' })).toEqual(['delta_incomplete']);
  });

  test('held and stale files', () => {
    expect(reasons('get_page', { slug: 'a', file_held: { code: 'invalid_frontmatter' } })).toEqual(['file_held']);
    expect(reasons('search', [], retrieval([]), [notice('held_files')])).toEqual(['held_files']);
  });

  test('think and synthesize: question embed, a failed evidence stream, a degraded page search', () => {
    for (const op of ['think', 'synthesize']) {
      expect(reasons(op, { warnings: ['QUESTION_EMBED_FAILED'] })).toEqual(['embed_unavailable']);
      expect(reasons(op, { warnings: ['GATHER_HYBRID_FAILED', 'GATHER_TAKES_VECTOR_FAILED'] })).toEqual(['gather_hybrid_failed', 'gather_takes_vector_failed']);
      expect(reasons(op, { warnings: ['GATHER_DEGRADED:embed_timeout', 'GATHER_DEGRADED:keyword_candidates_incomplete'] })).toEqual(['embed_timeout', 'keyword_candidates_incomplete']);
    }
  });

  test('result notices: an empty scope, references, mention index, relational chain, pinned answer, unembedded facts', () => {
    for (const code of ['sources_not_readable', 'references_unavailable', 'mention_index', 'relational_chain', 'pinned_answer_stale', 'facts_unembedded', 'delta_incomplete']) {
      expect(reasons('list_pages', [], null, [notice(code)])).toEqual([code]);
    }
  });

  test('ops that already report partial results in their body', () => {
    expect(reasons('search_exact', { complete: false, incomplete_reasons: ['deadline', 'limit', 'unreadable_pages'] })).toEqual(['scan_deadline', 'unreadable_pages']);
    expect(reasons('open_loops', { stale: true, completeness: 'partial' })).toEqual(['held_items', 'source_stale']);
    expect(reasons('open_loops', { stale: false, completeness: 'complete' })).toBeNull();
    expect(reasons('rank_entities', { coverage: { state: 'behind' } })).toEqual(['link_coverage_behind']);
    expect(reasons('rank_entities', { coverage: { state: 'current' } })).toBeNull();
  });

  test('reasons are sorted and unique across every channel', () => {
    expect(reasons('recall', { search_degraded: 'keyword_only_no_embedding_provider' },
      retrieval([{ stage: 'keyword_candidates_incomplete' }, { stage: 'embed_unavailable' }]), [notice('sources_not_readable'), notice('sources_not_readable')]))
      .toEqual(['embed_unavailable', 'keyword_candidates_incomplete', 'sources_not_readable']);
  });
});

describe('the one-line marker and the CLI placement', () => {
  const stamp = { reasons: ['embed_timeout', 'held_files'] };

  test('the text form is one line opening with the fixed prefix', () => {
    const line = degradedStampLine(stamp);
    expect(line.startsWith(`${DEGRADED_STAMP_PREFIX}embed_timeout, held_files] `)).toBe(true);
    expect(line).not.toContain('\n');
    expect(line).toContain('never report "no notes"');
  });

  test('--json object: a degraded key and no stderr line', () => {
    expect(withDegradedStamp({ facts: [] }, true, stamp)).toEqual({ result: { facts: [], degraded: stamp } });
  });

  test('--json array and human output: the body is unchanged and the line goes to stderr', () => {
    const rows = [{ slug: 'a' }];
    expect(withDegradedStamp(rows, true, stamp)).toEqual({ result: rows, stderr: degradedStampLine(stamp) + '\n' });
    expect(withDegradedStamp({ facts: [] }, false, stamp)).toEqual({ result: { facts: [] }, stderr: degradedStampLine(stamp) + '\n' });
  });

  test('no stamp leaves the output untouched', () => {
    expect(withDegradedStamp({ facts: [] }, true, null)).toEqual({ result: { facts: [] } });
    expect(withDegradedStamp([], false, { reasons: [] })).toEqual({ result: [] });
  });
});
