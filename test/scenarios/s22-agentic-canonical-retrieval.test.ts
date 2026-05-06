/**
 * Scenario S22 — Agentic canonical retrieval transcript coverage.
 *
 * Falsifies Task 7: "Agent retrieval transcripts must treat retrieve_context
 * output as candidate pointers only, then call read_context for bounded
 * canonical evidence before answering."
 */

import { describe, expect, test } from 'bun:test';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { buildStructuralContextMapEntry } from '../../src/core/services/context-map-service.ts';
import type { ReadContextResult, RetrieveContextResult } from '../../src/core/types.ts';
import { allocateSqliteBrain } from './helpers.ts';

function opContext(engine: OperationContext['engine']): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: false,
  };
}

describe('S22 — agentic canonical retrieval transcript', () => {
  test('retrieve_context returns candidate pointers, then read_context reads the canonical section evidence', async () => {
    const handle = await allocateSqliteBrain('s22-canonical-section');

    try {
      await seedCanonicalRetrievalPage(handle.engine);

      const retrieve = await operationsByName.retrieve_context.handler(opContext(handle.engine), {
        query: 'agent transcript needle is candidate-only',
        include_orientation: false,
        limit: 5,
      }) as RetrieveContextResult;

      expect(retrieve.answerability.answerable_from_probe).toBe(false);
      expect(retrieve.answerability.must_read_context).toBe(true);
      expect(retrieve.answerability.reason_codes).toContain('probe_candidates_are_not_answer_ground');
      expect(retrieve.warnings).toContain(
        'Search/query chunks are candidate pointers; call read_context before answering factual questions.',
      );
      expect(retrieve.candidates.length).toBeGreaterThan(0);
      expect(retrieve.candidates[0]!.activation).toBe('candidate_only');
      expect(retrieve.required_reads).toHaveLength(1);
      expect(retrieve.required_reads[0]!.kind).toBe('section');
      expect(typeof retrieve.required_reads[0]!.selector_id).toBe('string');

      const read = await operationsByName.read_context.handler(opContext(handle.engine), {
        selectors: retrieve.required_reads,
        token_budget: 400,
      }) as ReadContextResult;

      expect(read.answer_ready.ready).toBe(true);
      expect(read.answer_ready.answer_ground.map((selector) => selector.selector_id)).toContain(
        retrieve.required_reads[0]!.selector_id,
      );
      expect(read.canonical_reads).toHaveLength(1);
      expect(read.canonical_reads[0]!.authority).toBe('canonical_compiled_truth');
      expect(read.canonical_reads[0]!.text).toContain('Before the match, the section defines the transcript rule.');
      expect(read.canonical_reads[0]!.text).toContain('The agent transcript needle is candidate-only until read_context runs.');
      expect(read.canonical_reads[0]!.text).toContain('After the match, the section keeps the evidence bounded and canonical.');
    } finally {
      await handle.teardown();
    }
  });

  test('context-map orientation can recommend reads, but answering still requires canonical read_context evidence', async () => {
    const handle = await allocateSqliteBrain('s22-orientation');

    try {
      await seedLinkedOrientationPages(handle.engine);
      await buildStructuralContextMapEntry(handle.engine);

      const retrieve = await operationsByName.retrieve_context.handler(opContext(handle.engine), {
        query: 'canonical orientation target',
        include_orientation: true,
        limit: 5,
      }) as RetrieveContextResult;

      expect(
        retrieve.orientation.derived_consulted.length > 0
          || retrieve.orientation.recommended_reads.length > 0,
      ).toBe(true);
      expect(retrieve.answerability.answerable_from_probe).toBe(false);
      expect(retrieve.answerability.must_read_context).toBe(true);
      expect(retrieve.required_reads.length).toBeGreaterThan(0);
      expect(retrieve.required_reads.every((selector) => selector.kind !== 'source_ref')).toBe(true);

      const read = await operationsByName.read_context.handler(opContext(handle.engine), {
        selectors: retrieve.required_reads,
        token_budget: 500,
      }) as ReadContextResult;

      expect(read.answer_ready.ready).toBe(true);
      expect(read.canonical_reads.some((entry) =>
        entry.text.includes('Canonical orientation target requires a canonical read before answering.'),
      )).toBe(true);
    } finally {
      await handle.teardown();
    }
  });

  test('personal exact selectors are scope-gated before disclosure', async () => {
    const handle = await allocateSqliteBrain('s22-personal-gate');

    try {
      const retrieve = await operationsByName.retrieve_context.handler(opContext(handle.engine), {
        query: 'morning routine',
        requested_scope: 'work',
        selectors: [{
          kind: 'compiled_truth',
          scope_id: 'personal:default',
          slug: 'morning-routine',
        }],
      }) as RetrieveContextResult;

      expect(retrieve.scope_gate?.policy).not.toBe('allow');
      expect(retrieve.required_reads).toEqual([]);
      expect(retrieve.candidates).toEqual([]);
      expect(retrieve.answerability.answerable_from_probe).toBe(false);
      expect(retrieve.answerability.must_read_context).toBe(false);
      expect(retrieve.answerability.reason_codes).toContain(`scope_gate_${retrieve.scope_gate!.policy}`);
    } finally {
      await handle.teardown();
    }
  });

  test('exact selectors skip fuzzy discovery and go directly to canonical read_context evidence', async () => {
    const handle = await allocateSqliteBrain('s22-exact-selector');

    try {
      await importFromContent(handle.engine, 'concepts/exact-agentic-read', [
        '---',
        'type: concept',
        'title: Exact Agentic Read',
        '---',
        '# Compiled Truth',
        'Exact selector evidence is read without fuzzy candidate snippets.',
        '[Source: User, direct message, 2026-05-07 10:15 KST]',
      ].join('\n'), { path: 'concepts/exact-agentic-read.md' });

      const retrieve = await operationsByName.retrieve_context.handler(opContext(handle.engine), {
        query: 'concepts/exact-agentic-read',
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/exact-agentic-read' }],
      }) as RetrieveContextResult;

      expect(retrieve.answerability.reason_codes).toContain('exact_selectors_require_canonical_read');
      expect(retrieve.candidates).toHaveLength(1);
      expect(retrieve.candidates[0]!.matched_chunks).toEqual([]);
      expect(retrieve.required_reads[0]!.selector_id).toBe(
        'compiled_truth:workspace:default:concepts/exact-agentic-read',
      );

      const read = await operationsByName.read_context.handler(opContext(handle.engine), {
        selectors: retrieve.required_reads,
      }) as ReadContextResult;

      expect(read.answer_ready.ready).toBe(true);
      expect(read.canonical_reads[0]!.text).toContain('Exact selector evidence');
    } finally {
      await handle.teardown();
    }
  });

  test('task continuation probes require task working-set reads before other context', async () => {
    const handle = await allocateSqliteBrain('s22-task-continuation');

    try {
      await handle.engine.createTaskThread({
        id: 'task-s22-continuation',
        scope: 'work',
        title: 'S22 Continuation',
        status: 'active',
        repo_path: '/repo/mbrain',
        branch_name: 'agentic-canonical-retrieval',
        current_summary: 'Continue the agentic retrieval implementation.',
      });
      await handle.engine.upsertTaskWorkingSet({
        task_id: 'task-s22-continuation',
        active_paths: ['src/core/services/read-context-service.ts'],
        active_symbols: ['readContext'],
        blockers: [],
        open_questions: [],
        next_steps: ['Read task state before raw files.'],
        verification_notes: ['Run focused retrieval context tests.'],
      });

      const retrieve = await operationsByName.retrieve_context.handler(opContext(handle.engine), {
        query: 'continue this implementation',
        task_id: 'task-s22-continuation',
      }) as RetrieveContextResult;

      expect(retrieve.required_reads).toHaveLength(1);
      expect(retrieve.required_reads[0]!.kind).toBe('task_working_set');
      expect(retrieve.warnings).toContain(
        'Task continuation must read task state before raw files or graph orientation.',
      );

      const read = await operationsByName.read_context.handler(opContext(handle.engine), {
        selectors: retrieve.required_reads,
      }) as ReadContextResult;

      expect(read.answer_ready.ready).toBe(true);
      expect(read.canonical_reads[0]!.authority).toBe('operational_memory');
      expect(read.canonical_reads[0]!.text).toContain('Read task state before raw files.');
    } finally {
      await handle.teardown();
    }
  });

  test('no-match probes degrade explicitly without answer-ready evidence', async () => {
    const handle = await allocateSqliteBrain('s22-no-match');

    try {
      const retrieve = await operationsByName.retrieve_context.handler(opContext(handle.engine), {
        query: 'a term that does not exist in this scenario brain',
        include_orientation: false,
      }) as RetrieveContextResult;

      expect(retrieve.candidates).toEqual([]);
      expect(retrieve.required_reads).toEqual([]);
      expect(retrieve.answerability.answerable_from_probe).toBe(false);
      expect(retrieve.answerability.must_read_context).toBe(false);
      expect(retrieve.answerability.reason_codes).toContain('no_candidate');
      expect(retrieve.warnings).toContain('No canonical read candidate was found.');
    } finally {
      await handle.teardown();
    }
  });

  test('README registers S22 in the scenario contract table', async () => {
    const readme = await Bun.file(new URL('./README.md', import.meta.url)).text();

    expect(readme).toContain('S22');
    expect(readme).toContain('s22-agentic-canonical-retrieval.test.ts');
  });
});

async function seedCanonicalRetrievalPage(engine: OperationContext['engine']): Promise<void> {
  await importFromContent(engine, 'concepts/agentic-canonical-retrieval', [
    '---',
    'type: concept',
    'title: Agentic Canonical Retrieval',
    '---',
    '# Compiled Truth',
    'Before the match, the section defines the transcript rule.',
    'The agent transcript needle is candidate-only until read_context runs.',
    'After the match, the section keeps the evidence bounded and canonical.',
    '[Source: User, direct message, 2026-05-07 10:00 KST]',
  ].join('\n'), { path: 'concepts/agentic-canonical-retrieval.md' });
}

async function seedLinkedOrientationPages(engine: OperationContext['engine']): Promise<void> {
  await importFromContent(engine, 'systems/agentic-retrieval-map', [
    '---',
    'type: system',
    'title: Agentic Retrieval Map',
    '---',
    '# Overview',
    'The derived orientation page links to [[concepts/canonical-orientation-target]].',
    '[Source: User, direct message, 2026-05-07 10:05 KST]',
  ].join('\n'), { path: 'systems/agentic-retrieval-map.md' });

  await importFromContent(engine, 'concepts/canonical-orientation-target', [
    '---',
    'type: concept',
    'title: Canonical Orientation Target',
    '---',
    '# Compiled Truth',
    'Canonical orientation target requires a canonical read before answering.',
    'Backlink and context-map orientation can recommend the read, but cannot replace it.',
    '[Source: User, direct message, 2026-05-07 10:06 KST]',
  ].join('\n'), { path: 'concepts/canonical-orientation-target.md' });
}
