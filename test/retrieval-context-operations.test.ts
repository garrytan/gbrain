import { describe, expect, test } from 'bun:test';
import {
  formatResult,
  OperationError,
  operationsByName,
} from '../src/core/operations.ts';
import type { SearchResult } from '../src/core/types.ts';

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

    expect(read).toBeDefined();
    expect(read?.mutating).toBe(false);
    expect(read?.cliHints?.name).toBe('read-context');
    expect(read?.cliHints?.positional ?? []).toEqual([]);
    expect(read?.params.selectors?.type).toContain('string');
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

    const output = formatResult('retrieve_context', result);
    expect(output).toContain('Answerable from probe: no');
    expect(output).toContain('Must read context: yes');
    expect(output).toContain('Chunks are candidate pointers; call read_context before answering.');
    expect(output).toContain('Required reads:');
    expect(output).toContain('section:workspace:default:concepts/retrieval#compiled-truth');
  });

  test('read_context parses JSON selectors and preserves char offsets for bounded reads', async () => {
    const op = operationsByName.read_context;
    if (!op) throw new Error('read_context operation is missing');

    const engine = {
      getPage: async () => ({
        title: 'Retrieval',
        compiled_truth: 'Alpha Canonical evidence Omega',
        timeline: '',
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
    }) as any;

    expect(result.answer_ready.ready).toBe(true);
    expect(result.canonical_reads).toHaveLength(1);
    expect(result.canonical_reads[0].text).toBe('Canonical evidence');
    expect(result.canonical_reads[0].selector.char_start).toBe(6);
    expect(result.canonical_reads[0].selector.char_end).toBe(24);
    expect(result.canonical_reads[0].selector.selector_id).toContain('@chars:6:24');

    const output = formatResult('read_context', result);
    expect(output).toContain('Answer ready: yes');
    expect(output).toContain('Read: Retrieval');
    expect(output).toContain('Selector: line_span:workspace:default:concepts/retrieval:1:1@chars:6:24');
    expect(output).toContain('Canonical evidence');
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
});
