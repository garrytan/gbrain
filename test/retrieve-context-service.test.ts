import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importFromContent } from '../src/core/import-file.ts';
import { readContext } from '../src/core/services/read-context-service.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { retrieveContext } from '../src/core/services/retrieve-context-service.ts';
import { retrievalSelectorId } from '../src/core/services/retrieval-selector-service.ts';
import { sourceRankCandidateLimit } from '../src/core/search/source-ranking.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { MemoryCandidateEntryInput, SearchResult } from '../src/core/types.ts';

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

function makeMemoryCandidate(
  id: string,
  overrides: Partial<MemoryCandidateEntryInput> = {},
): MemoryCandidateEntryInput {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: `Candidate ${id} points to MBrain retrieval direction changes.`,
    source_refs: ['Source: User, direct message, 2026-05-16 12:00 KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.8,
    importance_score: 0.7,
    recurrence_score: 0.2,
    sensitivity: 'work',
    status: 'candidate',
    target_object_type: 'curated_note',
    target_object_id: 'systems/mbrain',
    ...overrides,
  };
}

describe('retrieve context service', () => {
  test('turns exact selectors into required reads without candidate search', async () => {
    await withEngine('exact', async (engine) => {
      await engine.createMemoryCandidateEntry(makeMemoryCandidate('candidate-exact-selector', {
        proposed_content: 'Exact selector retrieval should still expose MBrain direction candidates.',
      }));

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
      expect(result.candidate_signals.map((signal) => signal.candidate_id)).toContain('candidate-exact-selector');
    });
  });

  test('does not treat arbitrary sub-brain slug prefixes as personal scope by themselves', async () => {
    await withEngine('exact-sub-brain-prefix', async (engine) => {
      const result = await retrieveContext(engine, {
        query: 'work architecture',
        requested_scope: 'work',
        selectors: [{ kind: 'compiled_truth', slug: 'personal/work-architecture' }],
      }, {
        candidateSearch: async () => {
          throw new Error('gated exact selector retrieval must not search');
        },
      });

      expect(result.scope_gate?.policy).toBe('allow');
      expect(result.candidates).toHaveLength(1);
      expect(result.required_reads).toHaveLength(1);
      expect(result.required_reads[0]!.slug).toBe('personal/work-architecture');
      expect(result.answerability.answerable_from_probe).toBe(false);
      expect(result.answerability.must_read_context).toBe(true);
      expect(result.answerability.reason_codes).toContain('exact_selectors_require_canonical_read');
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

  test('selects a matching section when search snippets are truncated away from source text', async () => {
    await withEngine('query-section-fallback', async (engine) => {
      await importFromContent(engine, 'concepts/runtime-notes', [
        '---',
        'type: concept',
        'title: Runtime Notes',
        '---',
        '# Runtime Notes',
        'Runtime overview.',
        '',
        '## Common Driver Module',
        'Common module files and lifecycle.',
        '',
        '## Queue Routing',
        'Request dispatch uses queue ownership, worker coordination, and backpressure.',
      ].join('\n'), { path: 'concepts/runtime-notes.md' });

      const result = await retrieveContext(engine, {
        query: 'What is queue routing in the runtime?',
        include_orientation: false,
        limit: 5,
      }, {
        candidateSearch: async () => [{
          slug: 'concepts/runtime-notes',
          page_id: 1,
          title: 'Runtime Notes',
          type: 'concept',
          chunk_text: '# Runtime Notes ... This document covers runtime modules and queue routing.',
          chunk_source: 'compiled_truth',
          score: 10,
          stale: false,
        }],
      });

      expect(result.required_reads).toHaveLength(1);
      expect(result.required_reads[0]!.kind).toBe('section');
      expect(result.required_reads[0]!.section_id).toBe('concepts/runtime-notes#runtime-notes/queue-routing');
    });
  });

  test('ranks a widened candidate window before selecting required reads', async () => {
    await withEngine('wide-window-ranking', async (engine) => {
      await importFromContent(engine, 'concepts/queue-routing', [
        '---',
        'type: concept',
        'title: Queue Routing',
        '---',
        '# Queue Routing',
        'Queue routing is the canonical runtime coordination model.',
      ].join('\n'), { path: 'concepts/queue-routing.md' });

      for (let i = 1; i <= 6; i += 1) {
        await importFromContent(engine, `daily/2026-01-0${i}`, [
          '---',
          'type: concept',
          `title: Daily Note ${i}`,
          '---',
          '# Daily Note',
          `Daily note ${i} mentions queue routing as incidental meeting chatter.`,
        ].join('\n'), { path: `daily/2026-01-0${i}.md` });
      }

      const rawResults: SearchResult[] = [
        ...Array.from({ length: 6 }, (_, index) => ({
          slug: `daily/2026-01-0${index + 1}`,
          page_id: index + 1,
          title: `Daily Note ${index + 1}`,
          type: 'concept' as const,
          chunk_text: `Daily note ${index + 1} mentions queue routing as incidental meeting chatter.`,
          chunk_source: 'compiled_truth' as const,
          score: 1,
          stale: false,
        })),
        {
          slug: 'concepts/queue-routing',
          page_id: 99,
          title: 'Queue Routing',
          type: 'concept',
          chunk_text: 'Queue routing is the canonical runtime coordination model.',
          chunk_source: 'compiled_truth',
          score: 0.8,
          stale: false,
        },
      ];
      const seenLimits: number[] = [];
      expect(rawResults.slice(0, 5).some((result) => result.slug === 'concepts/queue-routing')).toBe(false);

      const result = await retrieveContext(engine, {
        query: 'queue routing',
        include_orientation: false,
        limit: 5,
      }, {
        candidateSearch: async (_query, options) => {
          seenLimits.push(options.limit);
          return rawResults.slice(0, options.limit);
        },
      });

      expect(seenLimits).toContain(sourceRankCandidateLimit(5));
      expect(result.required_reads[0]!.slug).toBe('concepts/queue-routing');
    });
  });

  test('recalls candidates from query variants when the full query is over-constrained', async () => {
    await withEngine('query-variant-recall', async (engine) => {
      await importFromContent(engine, 'concepts/queue-routing', [
        '---',
        'type: concept',
        'title: Queue Routing',
        '---',
        '# Queue Routing',
        'Queue routing assigns runtime requests to worker lanes.',
      ].join('\n'), { path: 'concepts/queue-routing.md' });
      await importFromContent(engine, 'systems/runtime-platform', [
        '---',
        'type: system',
        'title: Runtime Platform',
        '---',
        '# Runtime Platform',
        'The runtime platform has a generic overview for service operators.',
      ].join('\n'), { path: 'systems/runtime-platform.md' });

      const seenQueries: string[] = [];
      const result = await retrieveContext(engine, {
        query: 'How does queue routing work in the runtime platform?',
        include_orientation: false,
        limit: 1,
      }, {
        candidateSearch: async (query) => {
          seenQueries.push(query);
          if (query === 'queue' || query === 'routing') {
            return [{
              slug: 'concepts/queue-routing',
              page_id: 1,
              title: 'Queue Routing',
              type: 'concept',
              chunk_text: 'Queue routing assigns runtime requests to worker lanes.',
              chunk_source: 'compiled_truth',
              score: 1,
              stale: false,
            }];
          }
          return [{
            slug: 'systems/runtime-platform',
            page_id: 2,
            title: 'Runtime Platform',
            type: 'system',
            chunk_text: 'The runtime platform has a generic overview for service operators.',
            chunk_source: 'compiled_truth',
            score: 1,
            stale: false,
          }];
        },
      });

      expect(seenQueries).toContain('How does queue routing work in the runtime platform?');
      expect(seenQueries).toContain('queue');
      expect(seenQueries).toContain('routing');
      expect(result.required_reads[0]!.slug).toBe('concepts/queue-routing');
    });
  });

  test('does not let duplicate canonical pages consume multiple required-read slots', async () => {
    await withEngine('duplicate-page-family', async (engine) => {
      const duplicateContent = [
        '---',
        'type: concept',
        'title: Runtime Queue Routing',
        '---',
        '# Runtime Queue Routing',
        'Queue routing maps runtime work to the correct worker lane.',
      ].join('\n');
      await importFromContent(engine, 'concepts/runtime-queue-routing', duplicateContent, {
        path: 'concepts/runtime-queue-routing.md',
      });
      await importFromContent(engine, 'archive/runtime-queue-routing', duplicateContent, {
        path: 'concepts/runtime-queue-routing.md',
      });
      await importFromContent(engine, 'systems/worker-lanes', [
        '---',
        'type: system',
        'title: Worker Lanes',
        '---',
        '# Worker Lanes',
        'Worker lanes are the runtime queues that receive routed work.',
      ].join('\n'), { path: 'systems/worker-lanes.md' });

      const result = await retrieveContext(engine, {
        query: 'runtime queue routing worker lanes',
        include_orientation: false,
        limit: 2,
      }, {
        candidateSearch: async () => [
          {
            slug: 'concepts/runtime-queue-routing',
            page_id: 1,
            title: 'Runtime Queue Routing',
            type: 'concept',
            chunk_text: 'Queue routing maps runtime work to the correct worker lane.',
            chunk_source: 'compiled_truth',
            score: 1,
            stale: false,
          },
          {
            slug: 'archive/runtime-queue-routing',
            page_id: 2,
            title: 'Runtime Queue Routing',
            type: 'concept',
            chunk_text: 'Queue routing maps runtime work to the correct worker lane.',
            chunk_source: 'compiled_truth',
            score: 0.99,
            stale: false,
          },
          {
            slug: 'systems/worker-lanes',
            page_id: 3,
            title: 'Worker Lanes',
            type: 'system',
            chunk_text: 'Worker lanes are the runtime queues that receive routed work.',
            chunk_source: 'compiled_truth',
            score: 0.98,
            stale: false,
          },
        ],
      });

      expect(result.required_reads.map((selector) => selector.slug)).toEqual([
        'concepts/runtime-queue-routing',
        'systems/worker-lanes',
      ]);
    });
  });

  test('adds outgoing linked pages as connected canonical read candidates', async () => {
    await withEngine('outgoing-link-expansion', async (engine) => {
      await importFromContent(engine, 'systems/runtime-platform', [
        '---',
        'type: system',
        'title: Runtime Platform',
        '---',
        '# Runtime Platform',
        'Runtime platform overview. See [[concepts/queue-routing]].',
      ].join('\n'), { path: 'systems/runtime-platform.md' });
      await importFromContent(engine, 'concepts/queue-routing', [
        '---',
        'type: concept',
        'title: Queue Routing',
        '---',
        '# Queue Routing',
        'Queue routing explains how runtime work is assigned to lanes.',
      ].join('\n'), { path: 'concepts/queue-routing.md' });

      const result = await retrieveContext(engine, {
        query: 'runtime platform queue routing',
        include_orientation: false,
        limit: 2,
      }, {
        candidateSearch: async () => [{
          slug: 'systems/runtime-platform',
          page_id: 1,
          title: 'Runtime Platform',
          type: 'system',
          chunk_text: 'Runtime platform overview.',
          chunk_source: 'compiled_truth',
          score: 1,
          stale: false,
        }],
      });

      expect(result.required_reads.map((selector) => selector.slug)).toContain('concepts/queue-routing');
    });
  });

  test('adds backlink pages as connected canonical read candidates', async () => {
    await withEngine('backlink-expansion', async (engine) => {
      await importFromContent(engine, 'systems/runtime-platform', [
        '---',
        'type: system',
        'title: Runtime Platform',
        '---',
        '# Runtime Platform',
        'Runtime platform overview for synthetic services.',
      ].join('\n'), { path: 'systems/runtime-platform.md' });
      await importFromContent(engine, 'concepts/queue-routing', [
        '---',
        'type: concept',
        'title: Queue Routing',
        '---',
        '# Queue Routing',
        'Queue routing connects to [[systems/runtime-platform]] and explains worker lane assignment.',
      ].join('\n'), { path: 'concepts/queue-routing.md' });

      const result = await retrieveContext(engine, {
        query: 'queue routing runtime platform',
        include_orientation: false,
        limit: 2,
      }, {
        candidateSearch: async () => [{
          slug: 'systems/runtime-platform',
          page_id: 1,
          title: 'Runtime Platform',
          type: 'system',
          chunk_text: 'Runtime platform overview for synthetic services.',
          chunk_source: 'compiled_truth',
          score: 1,
          stale: false,
        }],
      });

      expect(result.required_reads.map((selector) => selector.slug)).toContain('concepts/queue-routing');
    });
  });

  test('adds explicit engine links as connected canonical read candidates', async () => {
    await withEngine('explicit-link-expansion', async (engine) => {
      await importFromContent(engine, 'systems/runtime-platform', [
        '---',
        'type: system',
        'title: Runtime Platform',
        '---',
        '# Runtime Platform',
        'Runtime platform overview for synthetic services.',
      ].join('\n'), { path: 'systems/runtime-platform.md' });
      await importFromContent(engine, 'concepts/queue-routing', [
        '---',
        'type: concept',
        'title: Queue Routing',
        '---',
        '# Queue Routing',
        'Queue routing explains worker lane assignment.',
      ].join('\n'), { path: 'concepts/queue-routing.md' });
      await engine.addLink('systems/runtime-platform', 'concepts/queue-routing', 'related routing concept', 'related');
      engine.listNoteManifestEntries = async () => {
        throw new Error('explicit link expansion should not scan all manifests');
      };

      const result = await retrieveContext(engine, {
        query: 'runtime platform queue routing',
        include_orientation: false,
        limit: 2,
      }, {
        candidateSearch: async () => [{
          slug: 'systems/runtime-platform',
          page_id: 1,
          title: 'Runtime Platform',
          type: 'system',
          chunk_text: 'Runtime platform overview for synthetic services.',
          chunk_source: 'compiled_truth',
          score: 1,
          stale: false,
        }],
      });

      expect(result.required_reads.map((selector) => selector.slug)).toContain('concepts/queue-routing');
    });
  });

  test('adds explicit engine backlinks as connected canonical read candidates', async () => {
    await withEngine('explicit-backlink-expansion', async (engine) => {
      await importFromContent(engine, 'systems/runtime-platform', [
        '---',
        'type: system',
        'title: Runtime Platform',
        '---',
        '# Runtime Platform',
        'Runtime platform overview for synthetic services.',
      ].join('\n'), { path: 'systems/runtime-platform.md' });
      await importFromContent(engine, 'concepts/queue-routing', [
        '---',
        'type: concept',
        'title: Queue Routing',
        '---',
        '# Queue Routing',
        'Queue routing explains worker lane assignment.',
      ].join('\n'), { path: 'concepts/queue-routing.md' });
      await engine.addLink('concepts/queue-routing', 'systems/runtime-platform', 'supports runtime platform', 'related');

      const result = await retrieveContext(engine, {
        query: 'queue routing runtime platform',
        include_orientation: false,
        limit: 2,
      }, {
        candidateSearch: async () => [{
          slug: 'systems/runtime-platform',
          page_id: 1,
          title: 'Runtime Platform',
          type: 'system',
          chunk_text: 'Runtime platform overview for synthetic services.',
          chunk_source: 'compiled_truth',
          score: 1,
          stale: false,
        }],
      });

      expect(result.required_reads.map((selector) => selector.slug)).toContain('concepts/queue-routing');
    });
  });

  test('keeps linked canonical pages under arbitrary sub-brain paths when work scope allows retrieval', async () => {
    await withEngine('work-scope-sub-brain-link', async (engine) => {
      await importFromContent(engine, 'systems/runtime-platform', [
        '---',
        'type: system',
        'title: Runtime Platform',
        '---',
        '# Runtime Platform',
        'Runtime platform overview. See [[personal/work-architecture]].',
      ].join('\n'), { path: 'systems/runtime-platform.md' });
      await importFromContent(engine, 'personal/work-architecture', [
        '---',
        'type: concept',
        'title: Work Architecture',
        '---',
        '# Work Architecture',
        'Work architecture fixture content connected from an arbitrary sub-brain path.',
      ].join('\n'), { path: 'personal/work-architecture.md' });
      await engine.addLink('personal/work-architecture', 'systems/runtime-platform', 'architecture backlink', 'related');

      const result = await retrieveContext(engine, {
        query: 'runtime platform code architecture',
        requested_scope: 'work',
        include_orientation: false,
        limit: 3,
      }, {
        candidateSearch: async () => [{
          slug: 'systems/runtime-platform',
          page_id: 1,
          title: 'Runtime Platform',
          type: 'system',
          chunk_text: 'Runtime platform overview.',
          chunk_source: 'compiled_truth',
          score: 1,
          stale: false,
        }],
      });

      expect(result.scope_gate?.policy).toBe('allow');
      expect(result.required_reads.map((selector) => selector.slug)).toContain('systems/runtime-platform');
      expect(result.required_reads.map((selector) => selector.slug)).toContain('personal/work-architecture');

      const read = await readContext(engine, {
        selectors: result.required_reads,
        requested_scope: 'work',
        token_budget: 500,
      });

      expect(read.scope_gate?.policy).toBe('allow');
      expect(read.canonical_reads.map((entry) => entry.selector.slug)).toContain('personal/work-architecture');
    });
  });

  test('adds manifest backlink candidates even when base search candidates fill the limit', async () => {
    await withEngine('backlink-expansion-filled-limit', async (engine) => {
      await importFromContent(engine, 'systems/runtime-platform', [
        '---',
        'type: system',
        'title: Runtime Platform',
        '---',
        '# Runtime Platform',
        'Runtime platform overview for synthetic services.',
      ].join('\n'), { path: 'systems/runtime-platform.md' });
      await importFromContent(engine, 'systems/runtime-dashboard', [
        '---',
        'type: system',
        'title: Runtime Dashboard',
        '---',
        '# Runtime Dashboard',
        'Runtime dashboard shows generic platform status.',
      ].join('\n'), { path: 'systems/runtime-dashboard.md' });
      await importFromContent(engine, 'concepts/queue-routing', [
        '---',
        'type: concept',
        'title: Queue Routing',
        '---',
        '# Queue Routing',
        'Queue routing connects to [[systems/runtime-platform]] and explains worker lane assignment.',
      ].join('\n'), { path: 'concepts/queue-routing.md' });

      const result = await retrieveContext(engine, {
        query: 'queue routing runtime platform',
        include_orientation: false,
        limit: 2,
      }, {
        candidateSearch: async () => [
          {
            slug: 'systems/runtime-platform',
            page_id: 1,
            title: 'Runtime Platform',
            type: 'system',
            chunk_text: 'Runtime platform overview for synthetic services.',
            chunk_source: 'compiled_truth',
            score: 1,
            stale: false,
          },
          {
            slug: 'systems/runtime-dashboard',
            page_id: 2,
            title: 'Runtime Dashboard',
            type: 'system',
            chunk_text: 'Runtime dashboard shows generic platform status.',
            chunk_source: 'compiled_truth',
            score: 0.99,
            stale: false,
          },
        ],
      });

      expect(result.required_reads.map((selector) => selector.slug)).toContain('concepts/queue-routing');
    });
  });

  test('resolves canonical read selectors for independent page candidates concurrently', async () => {
    await withEngine('selector-resolution-concurrency', async (engine) => {
      await importFromContent(engine, 'concepts/alpha', [
        '---',
        'type: concept',
        'title: Alpha',
        '---',
        '# Alpha',
        'Alpha compiled truth.',
      ].join('\n'), { path: 'concepts/alpha.md' });
      await importFromContent(engine, 'concepts/bravo', [
        '---',
        'type: concept',
        'title: Bravo',
        '---',
        '# Bravo',
        'Bravo compiled truth.',
      ].join('\n'), { path: 'concepts/bravo.md' });

      const originalListSections = engine.listNoteSectionEntries.bind(engine);
      let activeSectionReads = 0;
      let maxActiveSectionReads = 0;
      engine.listNoteSectionEntries = async (...args) => {
        activeSectionReads += 1;
        maxActiveSectionReads = Math.max(maxActiveSectionReads, activeSectionReads);
        await new Promise((resolve) => setTimeout(resolve, 20));
        try {
          return await originalListSections(...args);
        } finally {
          activeSectionReads -= 1;
        }
      };

      const result = await retrieveContext(engine, {
        query: 'compiled truth',
        include_orientation: false,
        limit: 2,
      }, {
        candidateSearch: async () => [
          {
            slug: 'concepts/alpha',
            page_id: 1,
            title: 'Alpha',
            type: 'concept',
            chunk_text: 'Alpha compiled truth.',
            chunk_source: 'compiled_truth',
            score: 10,
            stale: false,
          },
          {
            slug: 'concepts/bravo',
            page_id: 2,
            title: 'Bravo',
            type: 'concept',
            chunk_text: 'Bravo compiled truth.',
            chunk_source: 'compiled_truth',
            score: 9,
            stale: false,
          },
        ],
      });

      expect(result.required_reads).toHaveLength(2);
      expect(maxActiveSectionReads).toBeGreaterThan(1);
    });
  });

  test('returns candidate signals alongside canonical reads in default retrieval', async () => {
    await withEngine('candidate-signals-default', async (engine) => {
      await importFromContent(engine, 'systems/mbrain', [
        '---',
        'type: system',
        'title: MBrain',
        '---',
        '# Compiled Truth',
        'MBrain retrieval direction is grounded by canonical required reads.',
        '[Source: User, direct message, 2026-05-16 12:00 KST]',
      ].join('\n'), { path: 'systems/mbrain.md' });
      await engine.createMemoryCandidateEntry(makeMemoryCandidate('candidate-mbrain-direction', {
        proposed_content: 'MBrain direction should expose Memory Inbox candidate signals beside canonical reads.',
      }));

      const searchResults: SearchResult[] = [{
        slug: 'systems/mbrain',
        page_id: 1,
        title: 'MBrain',
        type: 'system',
        chunk_text: 'MBrain retrieval direction is grounded by canonical required reads.',
        chunk_source: 'compiled_truth',
        score: 10,
        stale: false,
      }];

      const result = await retrieveContext(engine, {
        query: 'mbrain retrieval direction',
        include_orientation: false,
        requested_scope: 'work',
        limit: 5,
      }, {
        candidateSearch: async () => searchResults,
      });

      expect(result.required_reads.some((selector) => selector.slug === 'systems/mbrain')).toBe(true);
      expect(JSON.stringify(result.required_reads)).not.toContain('candidate-mbrain-direction');
      expect(result.candidate_signal_policy.mode).toBe('expanded');
      expect(result.candidate_signals.map((signal) => signal.candidate_id)).toContain('candidate-mbrain-direction');
      const signal = result.candidate_signals.find((entry) => entry.candidate_id === 'candidate-mbrain-direction');
      expect(signal?.activation).toBe('candidate_only');
      expect(signal?.authority).toBe('unreviewed_candidate');
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

  test('persisted retrieve_context trace records candidate signal exposure outside canonical source refs', async () => {
    await withEngine('candidate-signal-trace', async (engine) => {
      const result = await retrieveContext(engine, {
        query: 'memory consolidation signal',
        requested_scope: 'work',
        persist_trace: true,
        include_orientation: false,
      }, {
        candidateSearch: async () => [],
        candidateSignalBuilder: async () => ({
          candidate_signal_policy: {
            mode: 'normal',
            reason_codes: ['default_agent_retrieval'],
            included_count: 1,
            suppressed_count: 0,
          },
          candidate_signals: [{
            candidate_id: 'candidate-trace-exposure',
            status: 'candidate',
            authority: 'unreviewed_candidate',
            activation: 'candidate_only',
            target_object_type: 'curated_note',
            target_object_id: 'systems/mbrain',
            relation_to_canonical: 'adjacent',
            score: 0.5,
            score_reasons: ['query_overlap'],
            promotion_hint: 'advance_to_review',
            disposition_hint: 'keep_candidate',
            pressure_score: 0.25,
            pressure_reasons: ['unresolved_exposed_candidate'],
            review_priority_hint: 'advance_to_review',
            summary: 'Unreviewed candidate candidate-trace-exposure may be relevant.',
          }],
        }),
      });

      expect(result.trace).toBeDefined();
      expect(result.trace!.verification).toContain('candidate_signal_policy:normal');
      expect(result.trace!.verification).toContain('candidate_signal:candidate-trace-exposure');
      expect(result.trace!.source_refs).not.toContain('candidate_signal:candidate-trace-exposure');
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
      await engine.createMemoryCandidateEntry(makeMemoryCandidate('candidate-scope-blocked', {
        proposed_content: 'Remember my personal routine candidate should not scan after a scope block.',
        target_object_id: 'personal/routine',
      }));

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
      expect(result.candidate_signal_policy.mode).toBe('strict');
      expect(result.candidate_signal_policy.reason_codes).toContain('scope_gate_blocked');
      expect(result.candidate_signals).toEqual([]);
    });
  });
});
