import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importFromContent } from '../src/core/import-file.ts';
import { readContext } from '../src/core/services/read-context-service.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { retrieveContext } from '../src/core/services/retrieve-context-service.ts';
import { retrievalSelectorId } from '../src/core/services/retrieval-selector-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { SearchResult } from '../src/core/types.ts';

async function withEngine<T>(label: string, fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-retrieve-context-${label}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('retrieve context service', () => {
  test('turns exact selectors into required reads without candidate search', async () => {
    await withEngine('exact', async (engine) => {
      const result = await retrieveContext(engine, {
        query: 'systems/mbrain',
        selectors: [{ kind: 'compiled_truth', slug: 'systems/mbrain' }],
      }, {
        candidateSearch: async () => {
          throw new Error('exact selector retrieval must not search');
        },
      });

      expect(result.route).toBeNull();
      expect(result.answerability.answerable_from_probe).toBe(false);
      expect(result.answerability.must_read_context).toBe(true);
      expect(result.required_reads).toHaveLength(1);
      expect(result.required_reads[0]!.selector_id).toBe('compiled_truth:workspace:default:systems/mbrain');
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.read_selector.selector_id).toBe(result.required_reads[0]!.selector_id);
      expect(result.candidates[0]!.activation).toBe('candidate_only');
    });
  });

  test('gates exact selectors with personal slugs before required reads', async () => {
    await withEngine('exact-personal-gate', async (engine) => {
      const result = await retrieveContext(engine, {
        query: 'morning routine',
        requested_scope: 'work',
        selectors: [{ kind: 'compiled_truth', slug: 'personal/morning-routine' }],
      }, {
        candidateSearch: async () => {
          throw new Error('gated exact selector retrieval must not search');
        },
      });

      expect(result.scope_gate?.policy).not.toBe('allow');
      expect(result.candidates).toEqual([]);
      expect(result.required_reads).toEqual([]);
      expect(result.answerability.answerable_from_probe).toBe(false);
      expect(result.answerability.must_read_context).toBe(false);
      expect(result.answerability.reason_codes).toContain(`scope_gate_${result.scope_gate!.policy}`);
    });
  });

  test('gates exact selectors with explicit personal scope before required reads', async () => {
    await withEngine('exact-personal-scope-gate', async (engine) => {
      const result = await retrieveContext(engine, {
        query: 'routine lookup',
        requested_scope: 'work',
        selectors: [{ kind: 'compiled_truth', scope_id: 'personal:default', slug: 'morning-routine' }],
      }, {
        candidateSearch: async () => {
          throw new Error('gated exact selector retrieval must not search');
        },
      });

      expect(result.scope_gate?.policy).not.toBe('allow');
      expect(result.candidates).toEqual([]);
      expect(result.required_reads).toEqual([]);
      expect(result.answerability.answerable_from_probe).toBe(false);
      expect(result.answerability.must_read_context).toBe(false);
      expect(result.answerability.reason_codes).toContain(`scope_gate_${result.scope_gate!.policy}`);
    });
  });

  test('turns task ids into task working-set required reads before file or graph context', async () => {
    await withEngine('task', async (engine) => {
      const result = await retrieveContext(engine, {
        query: 'continue the implementation task',
        task_id: 'task-agentic-retrieval',
      }, {
        candidateSearch: async () => {
          throw new Error('task continuation retrieval must not search');
        },
      });

      expect(result.answerability.answerable_from_probe).toBe(false);
      expect(result.answerability.must_read_context).toBe(true);
      expect(result.required_reads).toHaveLength(1);
      expect(result.required_reads[0]!.selector_id).toBe(
        'task_working_set:workspace:default:task-agentic-retrieval',
      );
      expect(result.candidates[0]!.read_selector.selector_id).toBe(result.required_reads[0]!.selector_id);
      expect(result.warnings).toContain(
        'Task continuation must read task state before raw files or graph orientation.',
      );
    });
  });

  test('groups chunk search results by canonical page and marks probe as not answer-ready', async () => {
    await withEngine('search', async (engine) => {
      await importFromContent(engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Retrieval chunks are candidate pointers, not answer evidence.',
        '[Source: User, direct message, 2026-05-07 09:00 KST]',
        '',
        '## Probe Contract',
        'Search/query chunks are candidate pointers; call read_context before answering factual questions.',
      ].join('\n'), { path: 'concepts/retrieval.md' });

      const searchResults: SearchResult[] = [
        {
          slug: 'concepts/retrieval',
          page_id: 1,
          title: 'Retrieval',
          type: 'concept',
          chunk_text: 'Retrieval chunks are candidate pointers, not answer evidence.',
          chunk_source: 'compiled_truth',
          score: 10,
          stale: false,
        },
        {
          slug: 'concepts/retrieval',
          page_id: 1,
          title: 'Retrieval',
          type: 'concept',
          chunk_text: 'Search/query chunks are candidate pointers; call read_context before answering factual questions.',
          chunk_source: 'compiled_truth',
          score: 8,
          stale: false,
        },
      ];

      const result = await retrieveContext(engine, {
        query: 'candidate pointers',
        include_orientation: false,
        limit: 5,
      }, {
        candidateSearch: async () => searchResults,
      });

      expect(result.answerability.answerable_from_probe).toBe(false);
      expect(result.answerability.must_read_context).toBe(true);
      expect(result.answerability.reason_codes).toContain('probe_candidates_are_not_answer_ground');
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.matched_chunks).toHaveLength(2);
      expect((result.candidates[0]!.matched_chunks[0] as any).chunk_text).toBeUndefined();
      expect(result.required_reads).toHaveLength(1);
      expect(result.required_reads[0]!.kind).toBe('section');
      expect(result.required_reads[0]!.slug).toBe('concepts/retrieval');
      expect(result.warnings).toContain(
        'Search/query chunks are candidate pointers; call read_context before answering factual questions.',
      );
    });
  });

  test('rejects invalid direct service limits before returning inconsistent candidates', async () => {
    await withEngine('invalid-limit', async (engine) => {
      await expect(retrieveContext(engine, {
        query: 'invalid limit',
        limit: 0,
      }, {
        candidateSearch: async () => [{
          slug: 'concepts/invalid-limit',
          page_id: 1,
          title: 'Invalid Limit',
          type: 'concept',
          chunk_text: 'invalid limit',
          chunk_source: 'compiled_truth',
          score: 1,
          stale: false,
        }],
      })).rejects.toThrow('limit must be a positive integer');
    });
  });

  test('localizes ellipsis snippets so canonical reads include the matched evidence', async () => {
    await withEngine('ellipsis-snippet', async (engine) => {
      const prefix = 'Prefix filler. '.repeat(160);
      const suffix = ' Suffix filler.'.repeat(80);
      await importFromContent(engine, 'concepts/long-retrieval', [
        '---',
        'type: concept',
        'title: Long Retrieval',
        '---',
        '# Compiled Truth',
        `${prefix}Needle evidence appears in the middle of a long canonical section.${suffix}`,
        '[Source: User, direct message, 2026-05-07 10:10 KST]',
      ].join('\n'), { path: 'concepts/long-retrieval.md' });

      const searchResults: SearchResult[] = [{
        slug: 'concepts/long-retrieval',
        page_id: 1,
        title: 'Long Retrieval',
        type: 'concept',
        chunk_text: '...Needle evidence appears in the middle of a long canonical section...',
        chunk_source: 'compiled_truth',
        score: 10,
        stale: false,
      }];

      const probe = await retrieveContext(engine, {
        query: 'Needle evidence',
        include_orientation: false,
      }, {
        candidateSearch: async () => searchResults,
      });

      expect(probe.required_reads).toHaveLength(1);
      expect(probe.required_reads[0]!.kind).toBe('section');
      expect(probe.required_reads[0]!.char_start).toBeGreaterThan(0);

      const read = await readContext(engine, {
        selectors: probe.required_reads,
        token_budget: 30,
      });

      expect(read.canonical_reads[0]!.text).toContain('Needle evidence appears');
    });
  });

  test('persists a retrieval trace when requested', async () => {
    await withEngine('persist-trace', async (engine) => {
      await engine.createTaskThread({
        id: 'task-retrieve-trace',
        scope: 'work',
        title: 'Retrieve Trace',
        status: 'active',
        repo_path: '/repo/mbrain',
        branch_name: 'feature/context',
        current_summary: 'Trace retrieve context.',
      });

      const result = await retrieveContext(engine, {
        query: 'continue retrieve context',
        task_id: 'task-retrieve-trace',
        persist_trace: true,
      });

      expect(result.trace?.task_id).toBe('task-retrieve-trace');
      expect(result.trace?.scope).toBe('work');
      expect(result.trace?.route).toEqual(['retrieve_context', 'task_working_set']);
      expect(result.trace?.source_refs).toContain('task_working_set:workspace:default:task-retrieve-trace');
    });
  });

  test('keeps timeline search hits as timeline range reads even when compiled truth text matches', async () => {
    await withEngine('timeline-search', async (engine) => {
      await importFromContent(engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Timeline-only update also appears in compiled truth.',
        '[Source: User, direct message, 2026-05-07 09:10 KST]',
        '',
        '---',
        '- **2026-05-07** | Timeline-only update also appears in compiled truth.',
      ].join('\n'), { path: 'concepts/retrieval.md' });

      const searchResults: SearchResult[] = [
        {
          slug: 'concepts/retrieval',
          page_id: 1,
          title: 'Retrieval',
          type: 'concept',
          chunk_text: 'Timeline-only update also appears in compiled truth.',
          chunk_source: 'timeline',
          score: 10,
          stale: false,
        },
      ];

      const result = await retrieveContext(engine, {
        query: 'timeline only update',
        include_orientation: false,
        limit: 5,
      }, {
        candidateSearch: async () => searchResults,
      });

      expect(result.required_reads).toHaveLength(1);
      expect(result.required_reads[0]!.kind).toBe('timeline_range');
    });
  });

  test('preserves timeline evidence reads when grouped compiled truth scores higher', async () => {
    await withEngine('timeline-group-top', async (engine) => {
      await importFromContent(engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Canonical summary has the strongest lexical score.',
        '[Source: User, direct message, 2026-05-07 09:15 KST]',
        '',
        '---',
        '- **2026-05-07** | Timeline evidence must stay as evidence.',
      ].join('\n'), { path: 'concepts/retrieval.md' });

      const searchResults: SearchResult[] = [
        {
          slug: 'concepts/retrieval',
          page_id: 1,
          title: 'Retrieval',
          type: 'concept',
          chunk_text: 'Canonical summary has the strongest lexical score.',
          chunk_source: 'compiled_truth',
          score: 20,
          stale: false,
        },
        {
          slug: 'concepts/retrieval',
          page_id: 1,
          title: 'Retrieval',
          type: 'concept',
          chunk_text: 'Timeline evidence must stay as evidence.',
          chunk_source: 'timeline',
          score: 10,
          stale: false,
        },
      ];

      const result = await retrieveContext(engine, {
        query: 'retrieval evidence',
        include_orientation: false,
        limit: 5,
      }, {
        candidateSearch: async () => searchResults,
      });

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.matched_chunks.map((chunk) => chunk.chunk_source)).toEqual([
        'compiled_truth',
        'timeline',
      ]);
      expect(result.candidates[0]!.read_selector.kind).toBe('timeline_range');
      expect(result.required_reads).toHaveLength(1);
      expect(result.required_reads[0]!.kind).toBe('timeline_range');
    });
  });

  test('uses context maps as orientation and keeps required reads canonical', async () => {
    await withEngine('orientation', async (engine) => {
      await importFromContent(engine, 'systems/mbrain', [
        '---',
        'type: system',
        'title: MBrain',
        '---',
        '# Overview',
        'See [[concepts/retrieval]].',
      ].join('\n'), { path: 'systems/mbrain.md' });
      await importFromContent(engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Retrieval is grounded by canonical reads.',
        '[Source: User, direct message, 2026-05-07 09:05 KST]',
      ].join('\n'), { path: 'concepts/retrieval.md' });
      await buildStructuralContextMapEntry(engine);

      const result = await retrieveContext(engine, {
        query: 'retrieval',
        include_orientation: true,
      }, {
        candidateSearch: async () => [],
      });

      expect(result.answerability.answerable_from_probe).toBe(false);
      expect(result.orientation.derived_consulted.some((ref) => ref.startsWith('context_map:'))).toBe(true);
      expect(result.orientation.recommended_reads.length).toBeGreaterThan(0);
      expect(result.required_reads.map(retrievalSelectorId)).toEqual(
        result.orientation.recommended_reads.map(retrievalSelectorId),
      );
      expect(result.required_reads.every((selector) => selector.kind !== 'source_ref')).toBe(true);
    });
  });

  test('scope denial or defer returns no candidates or snippets', async () => {
    await withEngine('scope', async (engine) => {
      const result = await retrieveContext(engine, {
        query: 'Remember my personal routine',
        requested_scope: 'work',
      });

      expect(result.scope_gate?.policy).not.toBe('allow');
      expect(result.candidates).toEqual([]);
      expect(result.required_reads).toEqual([]);
      expect(result.answerability.answerable_from_probe).toBe(false);
      expect(result.answerability.must_read_context).toBe(false);
      expect(result.answerability.reason_codes).toContain(`scope_gate_${result.scope_gate!.policy}`);
    });
  });
});
