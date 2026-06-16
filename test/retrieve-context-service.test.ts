import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importFromContent } from '../src/core/import-file.ts';
import { readContext } from '../src/core/services/read-context-service.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { getBroadSynthesisRoute } from '../src/core/services/broad-synthesis-route-service.ts';
import { planAssertionGraphFrontier } from '../src/core/services/assertion-frontier-retrieval-service.ts';
import { retrieveContext } from '../src/core/services/retrieve-context-service.ts';
import { retrievalSelectorId } from '../src/core/services/retrieval-selector-service.ts';
import { sourceRankCandidateLimit } from '../src/core/search/source-ranking.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { GraphFrontierEdge, GraphFrontierInput, GraphFrontierNode, Link, MemoryCandidateEntryInput, SearchResult } from '../src/core/types.ts';

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

  test('does not call graph frontier dependencies unless the explicit flag is enabled', async () => {
    await withEngine('graph-frontier-default-off', async (engine) => {
      const dependencies = {
        candidateSearch: async () => [],
        graphFrontierInputBuilder: () => {
          throw new Error('graph frontier must stay default-off');
        },
      };
      const result = await retrieveContext(engine, {
        query: 'graph frontier default off',
        include_orientation: false,
      }, dependencies);
      const disabledResult = await retrieveContext(engine, {
        query: 'graph frontier disabled',
        include_orientation: false,
        graph_frontier: { enabled: false },
      }, dependencies);

      expect(result.required_reads).toEqual([]);
      expect(result.orientation.derived_consulted).not.toContain('graph_frontier');
      expect(disabledResult.required_reads).toEqual([]);
      expect(disabledResult.orientation.derived_consulted).not.toContain('graph_frontier');
    });
  });

  test('adds explicit graph frontier canonical selectors to required reads without source-ref authority', async () => {
    await withEngine('graph-frontier-enabled', async (engine) => {
      await importFromContent(engine, 'systems/seed', [
        '---',
        'type: system',
        'title: Seed System',
        '---',
        '# Seed System',
        'Seed system text mentions graph frontier retrieval.',
      ].join('\n'), { path: 'systems/seed.md' });
      await importFromContent(engine, 'concepts/graph-target', [
        '---',
        'type: concept',
        'title: Graph Target',
        '---',
        '# Graph Target',
        'Graph frontier target is still read through canonical context.',
      ].join('\n'), { path: 'concepts/graph-target.md' });

      const nodes = graphFrontierFixtureNodes();
      const edges = graphFrontierFixtureEdges();
      let plannerInput: GraphFrontierInput | undefined;
      const result = await retrieveContext(engine, {
        query: 'graph frontier retrieval',
        include_orientation: false,
        persist_trace: true,
        limit: 3,
        graph_frontier: {
          enabled: true,
          max_depth: 1,
          fanout_cap: 5,
        },
      }, {
        candidateSearch: async () => [{
          slug: 'systems/seed',
          page_id: 1,
          title: 'Seed System',
          type: 'system',
          chunk_text: 'Seed system text mentions graph frontier retrieval.',
          chunk_source: 'compiled_truth',
          score: 10,
          stale: false,
        }],
        graphFrontierInputBuilder: () => ({
          scope_id: 'workspace:default',
          policy_version: 'policy:v1',
          seed_node_ids: ['assertion:seed'],
          nodes,
          edges,
        }),
        graphFrontierPlanner: (input) => {
          plannerInput = input;
          return planAssertionGraphFrontier(input);
        },
      });

      expect(result.required_reads.map((selector) => selector.slug)).toContain('systems/seed');
      expect(result.required_reads.map((selector) => selector.slug)).toContain('concepts/graph-target');
      expect(result.orientation.derived_consulted).toContain('graph_frontier');
      expect(result.orientation.graph_paths_considered).toContain(
        'graph_frontier_path:1 activation=canonical_read authority=selector_planning_only',
      );
      expect(plannerInput).toMatchObject({
        scope_id: 'workspace:default',
        policy_version: 'policy:v1',
        seed_node_ids: ['assertion:seed'],
        max_depth: 1,
        fanout_cap: 5,
      });
      expect(JSON.stringify(result.required_reads)).not.toContain('edge:seed-target');
      expect(result.trace?.derived_consulted).toContain('graph_frontier');
      expect(result.trace?.verification).toContain('graph_frontier_paths_considered:1');
      expect(result.trace?.verification).toContain('graph_frontier_authority:selector_planning_only');
      expect(result.trace?.source_refs.join('\n')).not.toContain('edge:seed-target');
    });
  });

  test('dedupes graph frontier reads with search-selected canonical reads', async () => {
    await withEngine('graph-frontier-dedupe', async (engine) => {
      await importFromContent(engine, 'concepts/graph-target', [
        '---',
        'type: concept',
        'title: Graph Target',
        '---',
        '# Graph Target',
        'Graph target appears from search and graph frontier.',
      ].join('\n'), { path: 'concepts/graph-target.md' });

      const result = await retrieveContext(engine, {
        query: 'graph target',
        include_orientation: false,
        limit: 3,
        graph_frontier: {
          enabled: true,
          max_depth: 1,
          fanout_cap: 5,
        },
      }, {
        candidateSearch: async () => [{
          slug: 'concepts/graph-target',
          page_id: 1,
          title: 'Graph Target',
          type: 'concept',
          chunk_text: 'Graph target appears from search and graph frontier.',
          chunk_source: 'compiled_truth',
          score: 10,
          stale: false,
        }],
        graphFrontierInputBuilder: () => ({
          scope_id: 'workspace:default',
          policy_version: 'policy:v1',
          seed_node_ids: ['assertion:seed'],
          nodes: graphFrontierFixtureNodes(),
          edges: graphFrontierFixtureEdges(),
        }),
      });

      expect(result.required_reads.filter((selector) => selector.slug === 'concepts/graph-target')).toHaveLength(1);
      expect(result.orientation.graph_paths_considered).toHaveLength(1);
    });
  });

  test('does not merge graph review or revalidation selectors into required reads', async () => {
    await withEngine('graph-frontier-verify-first', async (engine) => {
      await importFromContent(engine, 'systems/seed', [
        '---',
        'type: system',
        'title: Seed System',
        '---',
        '# Seed System',
        'Seed system text mentions graph frontier retrieval.',
      ].join('\n'), { path: 'systems/seed.md' });
      await importFromContent(engine, 'concepts/reverify-target', [
        '---',
        'type: concept',
        'title: Reverify Target',
        '---',
        '# Reverify Target',
        'Reverify target must not be treated as a normal graph-added required read.',
      ].join('\n'), { path: 'concepts/reverify-target.md' });

      const result = await retrieveContext(engine, {
        query: 'graph frontier reverify',
        include_orientation: false,
        limit: 3,
        graph_frontier: {
          enabled: true,
          max_depth: 1,
          fanout_cap: 5,
        },
      }, {
        candidateSearch: async () => [{
          slug: 'systems/seed',
          page_id: 1,
          title: 'Seed System',
          type: 'system',
          chunk_text: 'Seed system text mentions graph frontier retrieval.',
          chunk_source: 'compiled_truth',
          score: 10,
          stale: false,
        }],
        graphFrontierInputBuilder: () => ({
          scope_id: 'workspace:default',
          policy_version: 'policy:v1',
          seed_node_ids: ['assertion:seed'],
          nodes: [
            graphFrontierFixtureNodes()[0]!,
            {
              id: 'assertion:reverify',
              scope_id: 'workspace:default',
              policy_version: 'policy:v1',
              selector: {
                kind: 'page',
                scope_id: 'workspace:default',
                slug: 'concepts/reverify-target',
                freshness: 'current',
              },
            },
          ],
          edges: [{
            id: 'edge:seed-reverify',
            edge_type: 'requires_reverification',
            from_node_id: 'assertion:seed',
            to_node_id: 'assertion:reverify',
            scope_id: 'workspace:default',
            policy_version: 'policy:v1',
          }],
        }),
      });

      expect(result.required_reads.map((selector) => selector.slug)).toContain('systems/seed');
      expect(result.required_reads.map((selector) => selector.slug)).not.toContain('concepts/reverify-target');
      expect(result.orientation.graph_paths_considered).toContain(
        'graph_frontier_path:1 activation=verify_first authority=selector_planning_only',
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

  test('recalls multi-token phrase candidates before falling back to noisy token-only reads', async () => {
    await withEngine('query-phrase-recall', async (engine) => {
      await importFromContent(engine, 'concepts/queue-routing', [
        '---',
        'type: concept',
        'title: Queue Routing',
        '---',
        '# Queue Routing',
        'Queue routing coordinates worker lanes.',
      ].join('\n'), { path: 'concepts/queue-routing.md' });
      await importFromContent(engine, 'concepts/queue-glossary', [
        '---',
        'type: concept',
        'title: Queue Glossary',
        '---',
        '# Queue Glossary',
        'Queue glossary content is a broad token-only match.',
      ].join('\n'), { path: 'concepts/queue-glossary.md' });

      const seenQueries: string[] = [];
      const result = await retrieveContext(engine, {
        query: 'queue routing coordination',
        include_orientation: false,
        limit: 2,
      }, {
        candidateSearch: async (query) => {
          seenQueries.push(query);
          if (query === 'queue routing') {
            return [{
              slug: 'concepts/queue-routing',
              page_id: 1,
              title: 'Queue Routing',
              type: 'concept',
              chunk_text: 'Queue routing coordinates worker lanes.',
              chunk_source: 'compiled_truth',
              score: 0.5,
              stale: false,
            }];
          }
          if (query === 'queue' || query === 'routing') {
            return [{
              slug: 'concepts/queue-glossary',
              page_id: 2,
              title: 'Queue Glossary',
              type: 'concept',
              chunk_text: 'Queue glossary content is a broad token-only match.',
              chunk_source: 'compiled_truth',
              score: 10,
              stale: false,
            }];
          }
          return [];
        },
      });

      expect(seenQueries).toContain('queue routing');
      expect(result.required_reads[0]!.slug).toBe('concepts/queue-routing');
    });
  });

  test('returns a bounded evidence read plan with deferred candidates when selector budget is full', async () => {
    await withEngine('bounded-read-plan', async (engine) => {
      for (const slug of [
        'concepts/queue-routing',
        'systems/runtime-platform',
        'systems/worker-lanes',
        'concepts/backpressure',
      ]) {
        await importFromContent(engine, slug, [
          '---',
          'type: concept',
          `title: ${slug.split('/')[1]}`,
          '---',
          `# ${slug}`,
          `Canonical evidence for ${slug} and queue routing.`,
        ].join('\n'), { path: `${slug}.md` });
      }

      const result = await retrieveContext(engine, {
        query: 'queue routing runtime worker backpressure',
        include_orientation: false,
        limit: 4,
      }, {
        candidateSearch: async () => [
          'concepts/queue-routing',
          'systems/runtime-platform',
          'systems/worker-lanes',
          'concepts/backpressure',
        ].map((slug, index) => ({
          slug,
          page_id: index + 1,
          title: slug,
          type: 'concept' as const,
          chunk_text: `Canonical evidence for ${slug} and queue routing.`,
          chunk_source: 'compiled_truth' as const,
          score: 10 - index,
          stale: false,
        })),
      });

      expect(result.required_reads).toHaveLength(3);
      expect(result.read_plan).toMatchObject({
        mode: 'bounded_evidence',
        max_depth: 1,
        max_selectors: 3,
      });
      expect(result.read_plan.selected_selectors).toEqual(
        result.required_reads.map((selector) => retrievalSelectorId(selector)),
      );
      expect(result.read_plan.deferred_candidate_ids).toHaveLength(1);
      expect(result.read_plan.gap_reasons).toContain('candidate_pool_exceeds_read_budget');
      expect(result.read_plan.next_actions).toContain(
        'Call read_context with read_plan.selected_selector_snapshots before making factual claims.',
      );
    });
  });

  test('read plan snapshots preserve content_hash for stale selector guards', async () => {
    await withEngine('read-plan-snapshot-hash', async (engine) => {
      await importFromContent(engine, 'concepts/read-plan-snapshot', [
        '---',
        'type: concept',
        'title: Read Plan Snapshot',
        '---',
        '# Snapshot Evidence',
        'Snapshot handoff phrase is bound to the original page hash.',
      ].join('\n'), { path: 'concepts/read-plan-snapshot.md' });

      const result = await retrieveContext(engine, {
        query: 'snapshot handoff phrase',
        include_orientation: false,
        limit: 1,
      }, {
        candidateSearch: async () => [{
          slug: 'concepts/read-plan-snapshot',
          page_id: 1,
          title: 'Read Plan Snapshot',
          type: 'concept',
          chunk_text: 'Snapshot handoff phrase is bound to the original page hash.',
          chunk_source: 'compiled_truth',
          score: 8,
          stale: false,
        }],
      });

      expect(result.required_reads).toHaveLength(1);
      const snapshotHash = result.required_reads[0]!.content_hash;
      expect(snapshotHash).toBeDefined();
      const snapshots = (result.read_plan as any).selected_selector_snapshots;
      expect(snapshots).toEqual([expect.objectContaining({
        selector_id: result.required_reads[0]!.selector_id,
        content_hash: snapshotHash,
      })]);

      await importFromContent(engine, 'concepts/read-plan-snapshot', [
        '---',
        'type: concept',
        'title: Read Plan Snapshot',
        '---',
        '# Snapshot Evidence',
        'Updated evidence must not satisfy an old read-plan selector snapshot.',
      ].join('\n'), { path: 'concepts/read-plan-snapshot.md' });

      const staleRead = await readContext(engine, {
        selectors: snapshots,
        token_budget: 50,
      });

      expect(staleRead.canonical_reads).toEqual([]);
      const firstWarningCode = staleRead.selector_warnings?.[0]?.code;
      expect(firstWarningCode).toBeDefined();
      expect(['stale_selector', 'stale_continuation']).toContain(firstWarningCode!);
      expect(staleRead.answer_ready.ready).toBe(false);
      expect(staleRead.answer_ready.unsupported_reasons.some((reason) =>
        reason === 'stale_selector' || reason === 'stale_continuation'
      )).toBe(true);
    });
  });

  test('frontmatter-only matches read back frontmatter evidence', async () => {
    await withEngine('frontmatter-evidence-read', async (engine) => {
      await importFromContent(engine, 'systems/frontmatter-only-tooling', [
        '---',
        'type: system',
        'title: Frontmatter Only Tooling',
        'build_command: bun run frontmatter-evidence-only',
        '---',
        '# Frontmatter Only Tooling',
        'Compiled truth intentionally omits the unique command.',
      ].join('\n'), { path: 'systems/frontmatter-only-tooling.md' });

      const result = await retrieveContext(engine, {
        query: 'frontmatter evidence only',
        include_orientation: false,
        limit: 1,
      }, {
        candidateSearch: async () => [{
          slug: 'systems/frontmatter-only-tooling',
          page_id: 1,
          title: 'Frontmatter Only Tooling',
          type: 'system',
          chunk_text: 'build command: bun run frontmatter-evidence-only',
          chunk_source: 'frontmatter',
          score: 8,
          stale: false,
        }],
      });

      const selectors = (result.read_plan as any).selected_selector_snapshots ?? result.required_reads;
      const read = await readContext(engine, {
        selectors,
        token_budget: 80,
      });

      expect(result.required_reads[0]!.kind).toBe('frontmatter');
      expect(read.canonical_reads).toHaveLength(1);
      expect(read.canonical_reads[0]!.selector.kind).toBe('frontmatter');
      expect(read.canonical_reads[0]!.text).toContain('build command');
      expect(read.canonical_reads[0]!.text).toContain('bun run frontmatter-evidence-only');
      expect(read.answer_ready.ready).toBe(true);
    });
  });

  test('surfaces candidate search failures even when fallback variants return candidates', async () => {
    await withEngine('candidate-search-partial-failure', async (engine) => {
      await importFromContent(engine, 'concepts/backend-fallback-signal', [
        '---',
        'type: concept',
        'title: Backend Fallback Signal',
        '---',
        '# Backend Fallback Signal',
        'Backend fallback signal evidence remains readable after partial search failure.',
      ].join('\n'), { path: 'concepts/backend-fallback-signal.md' });
      const originalQuery = 'backend fallback signal';

      const result = await retrieveContext(engine, {
        query: originalQuery,
        include_orientation: false,
        limit: 1,
      }, {
        candidateSearch: async (candidateQuery) => {
          if (candidateQuery === originalQuery) {
            throw new Error('keyword backend unavailable');
          }
          return [{
            slug: 'concepts/backend-fallback-signal',
            page_id: 1,
            title: 'Backend Fallback Signal',
            type: 'concept',
            chunk_text: 'Backend fallback signal evidence remains readable after partial search failure.',
            chunk_source: 'compiled_truth',
            score: 6,
            stale: false,
          }];
        },
      });

      expect(result.required_reads).toHaveLength(1);
      expect(result.read_plan.gap_reasons).toContain('retrieval_backend_partial_failure');
      expect(result.warnings.some((warning) =>
        warning.includes('Candidate search failed for 1 of')
        && warning.includes('keyword backend unavailable')
      )).toBe(true);
    });
  });

  test('distinguishes candidate search backend failure from no candidate', async () => {
    await withEngine('candidate-search-total-failure', async (engine) => {
      const result = await retrieveContext(engine, {
        query: 'backend down evidence',
        include_orientation: false,
        limit: 1,
      }, {
        candidateSearch: async () => {
          throw new Error('search backend down');
        },
      });

      expect(result.required_reads).toEqual([]);
      expect(result.answerability.reason_codes).toContain('retrieval_backend_failed');
      expect(result.answerability.reason_codes).not.toContain('no_candidate');
      expect(result.read_plan.gap_reasons).toContain('retrieval_backend_failed');
      expect(result.warnings.some((warning) =>
        warning.includes('Candidate search failed for')
        && warning.includes('search backend down')
      )).toBe(true);
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
      const originalListManifest = engine.listNoteManifestEntries.bind(engine);
      engine.listNoteManifestEntries = async (filters) => {
        if (filters?.slug || filters?.slugs !== undefined) return originalListManifest(filters);
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

  test('batches manifest lookups for seed and linked candidate pages', async () => {
    await withEngine('candidate-manifest-batching', async (engine) => {
      await importFromContent(engine, 'systems/runtime-platform', [
        '---',
        'type: system',
        'title: Runtime Platform',
        '---',
        '# Runtime Platform',
        'Runtime platform overview links to [[concepts/queue-routing]].',
      ].join('\n'), { path: 'systems/runtime-platform.md' });
      await importFromContent(engine, 'systems/runtime-workers', [
        '---',
        'type: system',
        'title: Runtime Workers',
        '---',
        '# Runtime Workers',
        'Runtime workers link to [[concepts/worker-lanes]].',
      ].join('\n'), { path: 'systems/runtime-workers.md' });
      await importFromContent(engine, 'concepts/queue-routing', [
        '---',
        'type: concept',
        'title: Queue Routing',
        '---',
        '# Queue Routing',
        'Queue routing explains synthetic worker assignment.',
      ].join('\n'), { path: 'concepts/queue-routing.md' });
      await importFromContent(engine, 'concepts/worker-lanes', [
        '---',
        'type: concept',
        'title: Worker Lanes',
        '---',
        '# Worker Lanes',
        'Worker lanes describe runtime queue capacity.',
      ].join('\n'), { path: 'concepts/worker-lanes.md' });

      const originalListManifest = engine.listNoteManifestEntries.bind(engine);
      const manifestFilters: Array<{ slug?: string; slugs?: string[] }> = [];
      const batchedEngine = new Proxy(engine, {
        get(target, prop, receiver) {
          if (prop === 'getNoteManifestEntry') {
            return async () => {
              throw new Error('retrieve_context should batch manifest lookups');
            };
          }
          if (prop === 'listNoteManifestEntries') {
            return async (filters?: Parameters<SQLiteEngine['listNoteManifestEntries']>[0] & { slugs?: string[] }) => {
              manifestFilters.push({ slug: filters?.slug, slugs: filters?.slugs });
              return originalListManifest(filters);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as SQLiteEngine;

      const result = await retrieveContext(batchedEngine, {
        query: 'runtime queue worker lanes',
        include_orientation: false,
        limit: 4,
      }, {
        candidateSearch: async () => [
          {
            slug: 'systems/runtime-platform',
            page_id: 1,
            title: 'Runtime Platform',
            type: 'system',
            chunk_text: 'Runtime platform overview links to queue routing.',
            chunk_source: 'compiled_truth',
            score: 1,
            stale: false,
          },
          {
            slug: 'systems/runtime-workers',
            page_id: 2,
            title: 'Runtime Workers',
            type: 'system',
            chunk_text: 'Runtime workers link to worker lanes.',
            chunk_source: 'compiled_truth',
            score: 0.99,
            stale: false,
          },
        ],
      });

      expect(result.required_reads.map((selector) => selector.slug)).toContain('concepts/worker-lanes');
      expect(manifestFilters.some((filter) =>
        filter.slugs?.includes('systems/runtime-platform')
        && filter.slugs?.includes('systems/runtime-workers'))).toBe(true);
      expect(manifestFilters.some((filter) =>
        filter.slugs?.includes('concepts/queue-routing')
        && filter.slugs?.includes('concepts/worker-lanes'))).toBe(true);
      expect(manifestFilters.some((filter) => filter.slug)).toBe(false);
    });
  });

  test('uses batched explicit link lookups when the engine provides them', async () => {
    await withEngine('candidate-explicit-link-batching', async (engine) => {
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

      const link: Link = {
        from_slug: 'systems/runtime-platform',
        to_slug: 'concepts/queue-routing',
        link_type: 'related',
        context: 'batched routing concept',
      };
      let batchedLinkCalls = 0;
      const batchedEngine = new Proxy(engine, {
        get(target, prop, receiver) {
          if (prop === 'getLinks') return async () => [];
          if (prop === 'getBacklinks') return async () => [];
          if (prop === 'getLinksForSlugs') {
            return async (slugs: string[]) => {
              batchedLinkCalls += 1;
              return new Map(slugs.map((slug) => [
                slug,
                slug === link.from_slug ? [link] : [],
              ]));
            };
          }
          if (prop === 'getBacklinksForSlugs') {
            return async (slugs: string[]) => new Map(slugs.map((slug) => [slug, []]));
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as SQLiteEngine;

      const result = await retrieveContext(batchedEngine, {
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
      expect(batchedLinkCalls).toBe(1);
    });
  });

  test('keeps linked candidates when manifest links use non-canonical slug casing', async () => {
    await withEngine('candidate-manifest-link-casing', async (engine) => {
      await importFromContent(engine, 'systems/runtime-platform', [
        '---',
        'type: system',
        'title: Runtime Platform',
        '---',
        '# Runtime Platform',
        'Runtime platform overview links to queue routing.',
      ].join('\n'), { path: 'systems/runtime-platform.md' });
      await importFromContent(engine, 'concepts/queue-routing', [
        '---',
        'type: concept',
        'title: Queue Routing',
        '---',
        '# Queue Routing',
        'Queue routing explains worker lane assignment.',
      ].join('\n'), { path: 'concepts/queue-routing.md' });

      const manifest = await engine.getNoteManifestEntry('workspace:default', 'systems/runtime-platform');
      expect(manifest).not.toBeNull();
      await engine.upsertNoteManifestEntry({
        ...manifest!,
        outgoing_wikilinks: ['Concepts/Queue-Routing'],
      });

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
          chunk_text: 'Runtime platform overview links to queue routing.',
          chunk_source: 'compiled_truth',
          score: 1,
          stale: false,
        }],
      });

      expect(result.required_reads.map((selector) => selector.slug)).toContain('concepts/queue-routing');
    });
  });

  test('falls back to per-seed explicit links when batch link lookup fails', async () => {
    await withEngine('candidate-explicit-link-batch-fallback', async (engine) => {
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

      let perSeedLinkCalls = 0;
      const fallbackEngine = new Proxy(engine, {
        get(target, prop, receiver) {
          if (prop === 'getLinksForSlugs') {
            return async () => {
              throw new Error('simulated batch link failure');
            };
          }
          if (prop === 'getLinks') {
            return async (slug: string) => {
              perSeedLinkCalls += 1;
              return engine.getLinks(slug);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as SQLiteEngine;

      const result = await retrieveContext(fallbackEngine, {
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
      expect(perSeedLinkCalls).toBe(1);
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

  test('batches section lookups while resolving base and linked read selectors', async () => {
    await withEngine('selector-resolution-batching', async (engine) => {
      await importFromContent(engine, 'concepts/alpha', [
        '---',
        'type: concept',
        'title: Alpha',
        '---',
        '# Alpha',
        'Alpha links to [[concepts/charlie]] for selector batching context.',
        '',
        '## Selector Batching',
        'Alpha selector batching evidence should resolve to this section.',
      ].join('\n'), { path: 'concepts/alpha.md' });
      await importFromContent(engine, 'concepts/bravo', [
        '---',
        'type: concept',
        'title: Bravo',
        '---',
        '# Bravo',
        'Bravo compiled truth.',
        '',
        '## Selector Batching',
        'Bravo selector batching evidence should resolve to this section.',
      ].join('\n'), { path: 'concepts/bravo.md' });
      await importFromContent(engine, 'concepts/charlie', [
        '---',
        'type: concept',
        'title: Charlie',
        '---',
        '# Charlie',
        'Charlie compiled truth.',
        '',
        '## Linked Selector Batching',
        'Charlie linked selector batching evidence should resolve to this section.',
      ].join('\n'), { path: 'concepts/charlie.md' });

      const originalListSections = engine.listNoteSectionEntries.bind(engine);
      const originalGetPageProjection = engine.getPageProjection.bind(engine);
      const sectionCalls: Array<{ page_slug?: string; page_slugs?: string[]; limit?: number }> = [];
      engine.listNoteSectionEntries = async (filters) => {
        sectionCalls.push({
          page_slug: filters?.page_slug,
          page_slugs: (filters as { page_slugs?: string[] } | undefined)?.page_slugs,
          limit: filters?.limit,
        });
        return originalListSections(filters);
      };
      engine.getPageProjection = async (slug) => {
        if (slug === 'concepts/alpha' || slug === 'concepts/bravo' || slug === 'concepts/charlie') {
          throw new Error(`Unexpected selector projection lookup for ${slug}`);
        }
        return originalGetPageProjection(slug);
      };

      const result = await retrieveContext(engine, {
        query: 'selector batching evidence',
        include_orientation: false,
        limit: 3,
      }, {
        candidateSearch: async () => [
          {
            slug: 'concepts/alpha',
            page_id: 1,
            title: 'Alpha',
            type: 'concept',
            chunk_text: 'Alpha selector batching evidence should resolve to this section.',
            chunk_source: 'compiled_truth',
            score: 10,
            stale: false,
          },
          {
            slug: 'concepts/bravo',
            page_id: 2,
            title: 'Bravo',
            type: 'concept',
            chunk_text: 'Bravo selector batching evidence should resolve to this section.',
            chunk_source: 'compiled_truth',
            score: 9,
            stale: false,
          },
        ],
      });

      expect(sectionCalls).toHaveLength(2);
      expect(sectionCalls.every((call) => call.page_slug === undefined)).toBe(true);
      expect(sectionCalls[0]!.page_slugs).toEqual(['concepts/alpha', 'concepts/bravo']);
      expect(sectionCalls[1]!.page_slugs).toEqual(['concepts/charlie']);
      expect(result.required_reads).toHaveLength(3);
      expect(result.required_reads.map((selector) => selector.section_id).sort()).toEqual([
        'concepts/alpha#alpha/selector-batching',
        'concepts/bravo#bravo/selector-batching',
        'concepts/charlie#charlie/linked-selector-batching',
      ]);
    });
  });

  test('keeps sections for every slug when a batched selector page has many sections', async () => {
    await withEngine('selector-resolution-batching-cap', async (engine) => {
      const alphaSections = Array.from({ length: 110 }, (_, index) => [
        `## Alpha Filler ${String(index).padStart(3, '0')}`,
        `Alpha filler evidence ${index}.`,
      ].join('\n'));

      await importFromContent(engine, 'concepts/alpha', [
        '---',
        'type: concept',
        'title: Alpha',
        '---',
        '# Alpha',
        ...alphaSections,
      ].join('\n\n'), { path: 'concepts/alpha.md' });
      await importFromContent(engine, 'concepts/bravo', [
        '---',
        'type: concept',
        'title: Bravo',
        '---',
        '# Bravo',
        '## Retained Section',
        'Bravo retained evidence should still resolve to this section.',
      ].join('\n'), { path: 'concepts/bravo.md' });

      const originalListSections = engine.listNoteSectionEntries.bind(engine);
      const sectionCalls: Array<{ page_slug?: string; page_slugs?: string[]; per_page_limit?: number }> = [];
      engine.listNoteSectionEntries = async (filters) => {
        sectionCalls.push({
          page_slug: filters?.page_slug,
          page_slugs: (filters as { page_slugs?: string[] } | undefined)?.page_slugs,
          per_page_limit: (filters as { per_page_limit?: number } | undefined)?.per_page_limit,
        });
        return originalListSections(filters);
      };

      const result = await retrieveContext(engine, {
        query: 'bravo retained evidence',
        include_orientation: false,
        limit: 2,
      }, {
        candidateSearch: async () => [
          {
            slug: 'concepts/alpha',
            page_id: 1,
            title: 'Alpha',
            type: 'concept',
            chunk_text: 'Alpha filler evidence 109.',
            chunk_source: 'compiled_truth',
            score: 10,
            stale: false,
          },
          {
            slug: 'concepts/bravo',
            page_id: 2,
            title: 'Bravo',
            type: 'concept',
            chunk_text: 'Bravo retained evidence should still resolve to this section.',
            chunk_source: 'compiled_truth',
            score: 9,
            stale: false,
          },
        ],
      });

      expect(sectionCalls).toHaveLength(1);
      expect(sectionCalls[0]).toMatchObject({
        page_slug: undefined,
        page_slugs: ['concepts/alpha', 'concepts/bravo'],
        per_page_limit: 50,
      });
      expect(result.required_reads.map((selector) => selector.section_id)).toContain(
        'concepts/bravo#bravo/retained-section',
      );
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
      expect(result.required_reads[0]!.content_hash).toBeTruthy();
      const snapshots = result.read_plan.selected_selector_snapshots ?? [];
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.content_hash).toBe(result.required_reads[0]!.content_hash);
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

  test('uses context maps as orientation without making route reads the evidence boundary', async () => {
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
      expect(result.required_reads).toEqual([]);
      expect(result.read_plan.selected_selectors).toEqual([]);
      expect(result.read_plan.gap_reasons).toContain('orientation_reads_deferred');
      expect(result.read_plan.next_actions).toContain(
        'Broad-synthesis route contributes orientation reads only; read_plan.selected_selector_snapshots remains the evidence boundary.',
      );
    });
  });

  test('documents broad-synthesis orientation as separate from retrieve_context evidence ranking', async () => {
    await withEngine('broad-synthesis-orientation-contract', async (engine) => {
      await importFromContent(engine, 'concepts/canonical-memory', [
        '---',
        'type: concept',
        'title: Canonical Memory',
        '---',
        '# Compiled Truth',
        'Canonical Memory is the curated source of truth for broad synthesis.',
        '[Source: User, direct message, 2026-05-07 09:20 KST]',
      ].join('\n'), { path: 'concepts/canonical-memory.md' });
      await importFromContent(engine, 'systems/derived-memory-map', [
        '---',
        'type: system',
        'title: Canonical Memory System',
        '---',
        '# Overview',
        'The derived map discusses Canonical Memory for broad orientation, without being linked evidence.',
        '[Source: User, direct message, 2026-05-07 09:21 KST]',
      ].join('\n'), { path: 'systems/derived-memory-map.md' });
      await buildStructuralContextMapEntry(engine);

      const broadRoute = await getBroadSynthesisRoute(engine, {
        query: 'Canonical Memory',
        limit: 5,
      });
      const result = await retrieveContext(engine, {
        query: 'Canonical Memory',
        include_orientation: true,
        limit: 5,
      }, {
        candidateSearch: async () => [{
          slug: 'concepts/canonical-memory',
          page_id: 1,
          title: 'Canonical Memory',
          type: 'concept',
          chunk_text: 'Canonical Memory is the curated source of truth for broad synthesis.',
          chunk_source: 'compiled_truth',
          score: 10,
          stale: false,
        }],
      });

      const broadReadSlugs = broadRoute.route!.recommended_reads.map((read) => read.page_slug);
      expect(broadReadSlugs).toContain('systems/derived-memory-map');
      expect(result.orientation.recommended_reads.map((selector) => selector.slug))
        .toEqual(expect.arrayContaining(broadReadSlugs));
      expect(result.required_reads.map((selector) => selector.slug))
        .toContain('concepts/canonical-memory');
      expect(result.required_reads.map((selector) => selector.slug))
        .not.toContain('systems/derived-memory-map');
      expect(result.read_plan.selected_selectors.some((selectorId) =>
        selectorId.includes('systems/derived-memory-map'))).toBe(false);
      expect(result.read_plan.next_actions).toContain(
        'Broad-synthesis route contributes orientation reads only; read_plan.selected_selector_snapshots remains the evidence boundary.',
      );
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
        graph_frontier: { enabled: true },
      }, {
        graphFrontierInputBuilder: () => {
          throw new Error('scope-blocked retrieval must not call graph frontier');
        },
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

function graphFrontierFixtureNodes(): GraphFrontierNode[] {
  return [
    {
      id: 'assertion:seed',
      scope_id: 'workspace:default',
      policy_version: 'policy:v1',
      selector: {
        kind: 'page',
        scope_id: 'workspace:default',
        slug: 'systems/seed',
        freshness: 'current',
      },
    },
    {
      id: 'assertion:target',
      scope_id: 'workspace:default',
      policy_version: 'policy:v1',
      selector: {
        kind: 'page',
        scope_id: 'workspace:default',
        slug: 'concepts/graph-target',
        freshness: 'current',
      },
    },
  ];
}

function graphFrontierFixtureEdges(): GraphFrontierEdge[] {
  return [{
    id: 'edge:seed-target',
    edge_type: 'supports',
    from_node_id: 'assertion:seed',
    to_node_id: 'assertion:target',
    scope_id: 'workspace:default',
    policy_version: 'policy:v1',
  }];
}

describe('manifest backlink scan bounding', () => {
  test('caps the manifest scan for seeds with no recorded links instead of sweeping the whole brain', async () => {
    await withEngine('backlink-scan-cap', async (engine) => {
      await importFromContent(engine, 'systems/orphan-platform', [
        '---',
        'type: system',
        'title: Orphan Platform',
        '---',
        '# Orphan Platform',
        'A page with no outgoing links and no recorded backlinks.',
      ].join('\n'), { path: 'systems/orphan-platform.md' });

      const originalListManifest = engine.listNoteManifestEntries.bind(engine);
      let scanCalls = 0;
      const proxied = new Proxy(engine, {
        get(target, prop, receiver) {
          if (prop === 'listNoteManifestEntries') {
            // Simulate an arbitrarily large brain where no manifest links back
            // to the seed: every batch is full and irrelevant.
            return async (filters: { slug?: string; slugs?: string[]; limit: number; offset: number }) => {
              if (filters.slug || filters.slugs !== undefined) return originalListManifest(filters);
              scanCalls += 1;
              return Array.from({ length: filters.limit }, (_, index) => ({
                scope_id: 'workspace:default',
                page_id: 100_000 + filters.offset + index,
                slug: `noise/page-${filters.offset + index}`,
                path: `noise/page-${filters.offset + index}.md`,
                page_type: 'concept',
                title: `Noise ${filters.offset + index}`,
                frontmatter: {},
                aliases: [],
                tags: [],
                outgoing_wikilinks: ['concepts/unrelated'],
                outgoing_urls: [],
                source_refs: [],
                heading_index: [],
                content_hash: `hash-${filters.offset + index}`,
                extractor_version: 'test',
                last_indexed_at: '2026-06-12T00:00:00.000Z',
              }));
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as typeof engine;

      const result = await retrieveContext(proxied, {
        query: 'orphan platform',
        include_orientation: false,
        limit: 2,
      }, {
        candidateSearch: async () => [{
          slug: 'systems/orphan-platform',
          page_id: 1,
          title: 'Orphan Platform',
          type: 'system',
          chunk_text: 'A page with no outgoing links and no recorded backlinks.',
          chunk_source: 'compiled_truth',
          score: 1,
          stale: false,
        }],
      });

      expect(result.required_reads.length).toBeGreaterThan(0);
      // 5,000-row cap at 500 rows per batch.
      expect(scanCalls).toBeLessThanOrEqual(10);
      expect(scanCalls).toBeGreaterThan(0);
    });
  });
});
