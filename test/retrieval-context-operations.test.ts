import { describe, expect, test } from 'bun:test';
import {
  formatResult,
  OperationError,
  operationsByName,
} from '../src/core/operations.ts';
import type { MemoryCandidateEntry, SearchResult } from '../src/core/types.ts';

function opContext(engine: any) {
  return {
    engine,
    config: {} as any,
    logger: console,
    dryRun: false,
  };
}

describe('agentic retrieval context operations', () => {
  test('retrieve_context and read_context are registered as non-mutating operations with CLI hints', () => {
    const retrieve = operationsByName.retrieve_context;
    const read = operationsByName.read_context;

    expect(retrieve).toBeDefined();
    expect(retrieve?.mutating).toBe(false);
    expect(retrieve?.cliHints?.name).toBe('retrieve-context');
    expect(retrieve?.cliHints?.positional).toEqual(['query']);
    expect(retrieve?.params.graph_frontier).toBeDefined();
    expect(retrieve?.params.include_push_context).toBeDefined();

    expect(read).toBeDefined();
    expect(read?.mutating).toBe(false);
    expect(read?.cliHints?.name).toBe('read-context');
    expect(read?.cliHints?.positional ?? []).toEqual([]);
    expect(read?.params.selectors?.type).toContain('string');
    expect(read?.params.probe_context?.type).toContain('string');
  });

  test('retrieve_context returns candidates and required read selectors without making chunks answer ground', async () => {
    const op = operationsByName.retrieve_context;
    if (!op) throw new Error('retrieve_context operation is missing');

    const searchResults: SearchResult[] = [{
      slug: 'concepts/retrieval',
      page_id: 1,
      title: 'Retrieval',
      type: 'concept',
      chunk_text: 'Retrieval chunks are candidate pointers, not answer evidence.',
      chunk_source: 'compiled_truth',
      score: 7.5,
      stale: false,
    }];
    const engine = {
      searchKeyword: async () => searchResults,
      getPageProjection: async () => ({
        content_hash: 'page-hash-1',
      }),
      listNoteSectionEntries: async () => [{
        scope_id: 'workspace:default',
        page_slug: 'concepts/retrieval',
        page_path: 'concepts/retrieval.md',
        heading_path: ['Compiled Truth'],
        heading_text: 'Compiled Truth',
        section_id: 'concepts/retrieval#compiled-truth',
        line_start: 1,
        line_end: 4,
        source_refs: ['User, direct message, 2026-05-07 09:00 KST'],
        content_hash: 'hash-1',
        section_text: 'Retrieval chunks are candidate pointers, not answer evidence.',
      }],
      listMemoryCandidateEntries: async ({ status }: { status?: MemoryCandidateEntry['status'] } = {}) => {
        const candidates: MemoryCandidateEntry[] = [{
          id: 'candidate:operation-output',
          scope_id: 'workspace:default',
          candidate_type: 'fact',
          proposed_content: 'Candidate signal for retrieval operation output should stay non-canonical.',
          source_refs: ['Source: User, direct message, 2026-05-16 12:00 KST'],
          generated_by: 'manual',
          extraction_kind: 'manual',
          confidence_score: 0.8,
          importance_score: 0.6,
          recurrence_score: 0.1,
          sensitivity: 'work',
          status: 'candidate',
          target_object_type: 'curated_note',
          target_object_id: 'concepts/retrieval',
          reviewed_at: null,
          review_reason: null,
          verification_status: 'unverified',
          verification_method: null,
          verification_evidence: null,
          verification_source_refs: [],
          verified_at: null,
          created_at: new Date('2026-05-16T03:00:00.000Z'),
          updated_at: new Date('2026-05-16T03:00:00.000Z'),
        }];
        return status ? candidates.filter(candidate => candidate.status === status) : candidates;
      },
      listCanonicalHandoffEntries: async () => [],
    };

    const result = await op.handler(opContext(engine), {
      query: 'candidate pointers',
      include_orientation: false,
    }) as any;

    expect(result.answerability.answerable_from_probe).toBe(false);
    expect(result.answerability.must_read_context).toBe(true);
    expect(result.answerability.reason_codes).toContain('probe_candidates_are_not_answer_ground');
    expect(result.candidates).toHaveLength(1);
    expect(result.required_reads).toHaveLength(1);
    expect(result.required_reads[0].selector_id).toBe('section:workspace:default:concepts/retrieval#compiled-truth');
    expect(result.required_reads[0].line_start).toBe(1);
    expect(result.required_reads[0].line_end).toBe(4);
    expect(result.required_reads[0].content_hash).toBe('page-hash-1');
    expect(result.answer_trust_footer).toMatchObject({
      authority_class: 'not_answer_evidence',
      underlying_authorities: ['not_answer_evidence'],
      evidence_selectors: ['section:workspace:default:concepts/retrieval#compiled-truth'],
      write_status: 'no_write',
      next_verification_action: 'Call read_context with read_plan.selected_selector_snapshots before making factual claims.',
    });
    expect(result.answer_trust_footer.excluded_signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'candidate_signal', count: 1 }),
      expect.objectContaining({ kind: 'search_chunk', count: 1 }),
    ]));
    expect(JSON.stringify(result.candidate_signals)).not.toContain(
      'Candidate signal for retrieval operation output should stay non-canonical.',
    );

    const output = formatResult('retrieve_context', result);
    expect(output).toContain('Answerable from probe: no');
    expect(output).toContain('Must read context: yes');
    expect(output).toContain('Chunks are candidate pointers; call read_context before answering.');
    expect(output).toContain('Required reads:');
    expect(output).toContain('section:workspace:default:concepts/retrieval#compiled-truth');
    expect(output).toContain('Read plan: mode=bounded_evidence max_depth=1 selected=1');
    expect(output).toContain('Call read_context with read_plan.selected_selector_snapshots before making factual claims.');
    expect(output).toContain('Candidate signal policy:');
    expect(output).toContain('candidate:operation-output');
    expect(output).toContain('promotion=advance_to_review');
    expect(output).toContain('disposition=keep_candidate');
    expect(output).toContain('Candidate signals are non-canonical; do not use them as answer evidence.');
    expect(output).not.toContain('Candidate signal for retrieval operation output should stay non-canonical.');
  });

  test('retrieve_context emits selector-first push context only as bounded read_context pointers', async () => {
    const op = operationsByName.retrieve_context;
    if (!op) throw new Error('retrieve_context operation is missing');

    const searchResults: SearchResult[] = [{
      slug: 'concepts/push-context',
      page_id: 1,
      title: 'Push Context',
      type: 'concept',
      chunk_text: 'Push context chunks must not be copied into the envelope.',
      chunk_source: 'compiled_truth',
      score: 7.5,
      stale: false,
    }];
    const engine = {
      searchKeyword: async () => searchResults,
      getPageProjection: async () => ({
        content_hash: 'page-hash-push-context',
      }),
      listNoteSectionEntries: async () => [{
        scope_id: 'workspace:default',
        page_slug: 'concepts/push-context',
        page_path: 'concepts/push-context.md',
        heading_path: ['Compiled Truth'],
        heading_text: 'Compiled Truth',
        section_id: 'concepts/push-context#compiled-truth',
        line_start: 1,
        line_end: 4,
        source_refs: ['Source: User, direct message, 2026-06-21 23:30 KST'],
        content_hash: 'section-hash-push-context',
        section_text: 'Push context chunks must not be copied into the envelope.',
      }],
      listMemoryCandidateEntries: async () => [{
        id: 'candidate:push-context',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'Candidate content must not be copied into the envelope.',
        source_refs: ['Source: User, direct message, 2026-06-21 23:31 KST'],
        generated_by: 'manual',
        extraction_kind: 'manual',
        confidence_score: 0.8,
        importance_score: 0.6,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'candidate',
        target_object_type: 'curated_note',
        target_object_id: 'concepts/push-context',
        reviewed_at: null,
        review_reason: null,
        verification_status: 'unverified',
        verification_method: null,
        verification_evidence: null,
        verification_source_refs: [],
        verified_at: null,
        created_at: new Date('2026-06-21T14:31:00.000Z'),
        updated_at: new Date('2026-06-21T14:31:00.000Z'),
      } satisfies MemoryCandidateEntry],
      listCanonicalHandoffEntries: async () => [],
    };

    const result = await op.handler(opContext(engine), {
      query: 'push context',
      include_orientation: false,
      include_push_context: true,
    }) as any;

    expect(result.push_context).toMatchObject({
      schema_version: 1,
      envelope_kind: 'selector_first_push_context',
      not_answer_ground_until_read_context: true,
      required_next_tool: 'read_context',
      read_context_arguments: {
        selectors: [expect.objectContaining({
          selector_id: 'section:workspace:default:concepts/push-context#compiled-truth',
          content_hash: 'page-hash-push-context',
        })],
      },
    });
    expect(result.push_context.selector_ids).toEqual([
      'section:workspace:default:concepts/push-context#compiled-truth',
    ]);
    expect(result.push_context.source_ref_count).toBe(1);
    expect(JSON.stringify(result.push_context)).not.toContain('Push context chunks');
    expect(JSON.stringify(result.push_context)).not.toContain('Candidate content');
    expect(JSON.stringify(result.push_context)).not.toContain('Source: User');
  });

  test('read_context parses JSON selectors and preserves char offsets for bounded reads', async () => {
    const op = operationsByName.read_context;
    if (!op) throw new Error('read_context operation is missing');

    const engine = {
      getPageLineSpanProjection: async () => ({
        id: 1,
        slug: 'concepts/retrieval',
        type: 'concept',
        title: 'Retrieval',
        frontmatter: {},
        content_hash: 'page-hash-1',
        created_at: new Date('2026-05-07T00:00:00.000Z'),
        updated_at: new Date('2026-05-07T00:00:00.000Z'),
        text: 'Alpha Canonical evidence Omega',
        line_start: 1,
        line_end: 1,
      }),
    };

    const result = await op.handler(opContext(engine), {
      selectors: JSON.stringify([{
        kind: 'line_span',
        slug: 'concepts/retrieval',
        line_start: 1,
        line_end: 1,
        char_start: 6,
        char_end: 24,
      }]),
      token_budget: 20,
      include_source_refs: false,
      probe_context: JSON.stringify({
        retrieve_trace_ids: ['retrieve-trace-1'],
        candidate_signal_count: 2,
        search_chunk_count: 1,
        context_map_consulted: true,
      }),
    }) as any;

    expect(result.canonical_reads).toHaveLength(1);
    expect(result.canonical_reads[0].text).toBe('Canonical evidence');
    expect(result.canonical_reads[0].selector.char_start).toBe(6);
    expect(result.canonical_reads[0].selector.char_end).toBe(24);
    expect(result.canonical_reads[0].selector.selector_id).toContain('@chars:6:24');
    expect(result.answer_trust_footer).toMatchObject({
      authority_class: 'canonical_read',
      underlying_authorities: ['source_or_timeline_evidence'],
      evidence_selectors: ['line_span:workspace:default:concepts/retrieval:1:1@chars:6:24'],
      trace_ids: ['retrieve-trace-1'],
      write_status: 'no_write',
    });
    expect(result.answer_trust_footer.excluded_signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'candidate_signal', count: 2 }),
      expect.objectContaining({ kind: 'search_chunk', count: 1 }),
      expect.objectContaining({ kind: 'context_map' }),
    ]));

    const output = formatResult('read_context', result);
    expect(output).toContain('Answer ready: yes');
    expect(output).toContain('Read: Retrieval');
    expect(output).toContain('Selector: line_span:workspace:default:concepts/retrieval:1:1@chars:6:24');
    expect(output).toContain('Canonical evidence');
  });

  test('read_context accepts frontmatter selector snapshots from retrieve_context read plans', async () => {
    const op = operationsByName.read_context;
    if (!op) throw new Error('read_context operation is missing');

    const engine = {
      getPageProjection: async (slug: string) => ({
        slug,
        title: 'Frontmatter Evidence',
        frontmatter: {
          build_command: 'bun run frontmatter-evidence',
          test_command: 'bun test frontmatter-evidence',
        },
        content_hash: 'frontmatter-hash-1',
      }),
      getPageFrontmatterProjection: async (slug: string) => ({
        id: 1,
        slug,
        type: 'concept',
        title: 'Frontmatter Evidence',
        frontmatter: {
          build_command: 'bun run frontmatter-evidence',
          test_command: 'bun test frontmatter-evidence',
        },
        content_hash: 'frontmatter-hash-1',
        created_at: new Date('2026-05-07T00:00:00.000Z'),
        updated_at: new Date('2026-05-07T00:00:00.000Z'),
        text: 'build_command: bun run frontmatter-evidence\ntest_command: bun test frontmatter-evidence',
      }),
    };

    const result = await op.handler(opContext(engine), {
      selectors: JSON.stringify([{
        kind: 'frontmatter',
        scope_id: 'workspace:default',
        slug: 'concepts/frontmatter-evidence',
        content_hash: 'frontmatter-hash-1',
      }]),
      token_budget: 20,
      include_source_refs: false,
    }) as any;

    expect(result.canonical_reads).toHaveLength(1);
    expect(result.canonical_reads[0].selector.kind).toBe('frontmatter');
    expect(result.canonical_reads[0].text).toContain('bun run frontmatter-evidence');
  });

  test('retrieval selector parsing accepts corpus_lane metadata without changing selector ids', async () => {
    const op = operationsByName.retrieve_context;
    if (!op) throw new Error('retrieve_context operation is missing');

    const engine = {
      listMemoryCandidateEntries: async () => [],
      listCanonicalHandoffEntries: async () => [],
    };

    const result = await op.handler(opContext(engine), {
      selectors: [{
        kind: 'compiled_truth',
        slug: 'concepts/retrieval',
        corpus_lane: {
          lane_id: 'transcripts',
          source_record: 'source-record:meeting-42',
          import_origin: 'imports/meeting-42.md',
          artifact_kind: 'transcript',
        },
      }],
    }) as any;

    expect(result.required_reads[0].corpus_lane).toEqual({
      lane_id: 'transcripts',
      source_record: 'source-record:meeting-42',
      import_origin: 'imports/meeting-42.md',
      artifact_kind: 'transcript',
    });
    expect(result.required_reads[0].selector_id).toBe('compiled_truth:workspace:default:concepts/retrieval');
  });

  test('retrieval selector parsing rejects invalid corpus_lane shapes', async () => {
    const op = operationsByName.retrieve_context;
    if (!op) throw new Error('retrieve_context operation is missing');

    await expect(op.handler(opContext({}), {
      selectors: [{ kind: 'compiled_truth', slug: 'concepts/retrieval', corpus_lane: 'transcripts' }],
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(op.handler(opContext({}), {
      selectors: [{
        kind: 'compiled_truth',
        slug: 'concepts/retrieval',
        corpus_lane: { lane_id: 'transcripts', source_record: 42 },
      }],
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(op.handler(opContext({}), {
      selectors: [{
        kind: 'compiled_truth',
        slug: 'concepts/retrieval',
        corpus_lane: { lane_id: 'transcripts', artifact_kind: 'not-real' },
      }],
    })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('read_context rejects invalid selector JSON with invalid_params', async () => {
    const op = operationsByName.read_context;
    if (!op) throw new Error('read_context operation is missing');

    try {
      await op.handler(opContext({}), {
        selectors: '{not-json',
      });
      throw new Error('expected invalid selector JSON to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as Error).message).toContain('selectors must be valid JSON');
    }
  });

  test('retrieval context operations reject invalid numeric budgets and limits', async () => {
    const retrieve = operationsByName.retrieve_context;
    const read = operationsByName.read_context;
    if (!retrieve || !read) throw new Error('retrieval context operations are missing');

    for (const params of [
      { limit: 0 },
      { limit: 1.5 },
      { token_budget: 0 },
    ]) {
      await expect(retrieve.handler(opContext({}), params)).rejects.toMatchObject({
        code: 'invalid_params',
      });
    }

    for (const params of [
      { max_selectors: 0 },
      { max_selectors: 1.5 },
      { token_budget: -1 },
    ]) {
      await expect(read.handler(opContext({}), params)).rejects.toMatchObject({
        code: 'invalid_params',
      });
    }
  });

  test('retrieve_context rejects invalid graph frontier options', async () => {
    const retrieve = operationsByName.retrieve_context;
    if (!retrieve) throw new Error('retrieve_context operation is missing');

    await expect(retrieve.handler(opContext({}), {
      graph_frontier: { enabled: true, max_depth: -1 },
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(retrieve.handler(opContext({}), {
      graph_frontier: { enabled: true, allowed_edge_types: ['derived_from'] },
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(retrieve.handler(opContext({
      listMemoryCandidateEntries: async () => [],
      listCanonicalHandoffEntries: async () => [],
    }), {
      graph_frontier: '{"enabled":true,"max_depth":1}',
    })).resolves.toMatchObject({
      orientation: expect.objectContaining({
        derived_consulted: [],
      }),
    });
  });
});
