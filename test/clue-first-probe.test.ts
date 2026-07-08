import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveConfig } from '../src/core/config.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { createProductionRetrieveContextDependencies } from '../src/core/services/production-retrieval-dependencies-service.ts';
import { retrieveContext } from '../src/core/services/retrieve-context-service.ts';
import type { RetrieveContextDependencies } from '../src/core/services/retrieve-context-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';

async function withEngine<T>(label: string, fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-clue-first-${label}-`));
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

// The weak-pool page: its title/slug shares no token with WEAK_QUERY, so the
// top resolved candidate scores below the weak-pool threshold, but its
// compiled-truth chunk is retrievable and feeds the clue generator.
const MEMORY_INBOX_RESULT: SearchResult = {
  slug: 'concepts/memory-inbox',
  page_id: 1,
  title: 'Memory Inbox',
  type: 'concept',
  chunk_text: 'MBrain governance signals aggregate into the memory inbox review lane before any outlook is compiled.',
  chunk_source: 'compiled_truth',
  score: 4,
  stale: false,
};

// Only reachable through the clue variant ("provenance" never appears in the
// original query or its deterministic variants).
const PROVENANCE_RESULT: SearchResult = {
  slug: 'concepts/provenance-tracing',
  page_id: 2,
  title: 'Provenance Tracing',
  type: 'concept',
  chunk_text: 'Provenance tracing follows refuted claims to every downstream consumer.',
  chunk_source: 'compiled_truth',
  score: 9,
  stale: false,
};

// Strong-pool page: title matches every token of STRONG_QUERY, so the top
// resolved candidate scores far above the weak-pool threshold.
const STRONG_RESULT: SearchResult = {
  slug: 'concepts/retrieval-evidence-contract',
  page_id: 3,
  title: 'Retrieval Evidence Contract',
  type: 'concept',
  chunk_text: 'Retrieval evidence contract: probes are pointers, read_context is the evidence boundary.',
  chunk_source: 'compiled_truth',
  score: 10,
  stale: false,
};

// Three meaningful tokens -> six deterministic base variants, leaving headroom
// under MAX_CANDIDATE_QUERY_VARIANTS for the clue lane.
const WEAK_QUERY = 'big picture outlook';
const STRONG_QUERY = 'retrieval evidence contract';
const CLUE_TEXT = 'Hypothesis: provenance tracing links the governance signals into one outlook.';

function makeCandidateSearch(calls: string[]): NonNullable<RetrieveContextDependencies['candidateSearch']> {
  return async (query, options) => {
    calls.push(query);
    const normalized = query.toLowerCase();
    const matches: SearchResult[] = [];
    if (normalized.includes('outlook')) matches.push(MEMORY_INBOX_RESULT);
    if (normalized.includes('provenance')) matches.push(PROVENANCE_RESULT);
    if (normalized.includes('retrieval')) matches.push(STRONG_RESULT);
    return matches.slice(0, options.limit);
  };
}

async function seedCorpus(engine: SQLiteEngine): Promise<void> {
  await importFromContent(engine, 'concepts/memory-inbox', [
    '---',
    'type: concept',
    'title: Memory Inbox',
    '---',
    '# Compiled Truth',
    'MBrain governance signals aggregate into the memory inbox review lane before any outlook is compiled.',
    '[Source: User, direct message, 2026-07-06 09:00 KST]',
  ].join('\n'), { path: 'concepts/memory-inbox.md' });
  await importFromContent(engine, 'concepts/provenance-tracing', [
    '---',
    'type: concept',
    'title: Provenance Tracing',
    '---',
    '# Compiled Truth',
    'Provenance tracing follows refuted claims to every downstream consumer.',
    '[Source: User, direct message, 2026-07-06 09:05 KST]',
  ].join('\n'), { path: 'concepts/provenance-tracing.md' });
  await importFromContent(engine, 'concepts/retrieval-evidence-contract', [
    '---',
    'type: concept',
    'title: Retrieval Evidence Contract',
    '---',
    '# Compiled Truth',
    'Retrieval evidence contract: probes are pointers, read_context is the evidence boundary.',
    '[Source: User, direct message, 2026-07-06 09:10 KST]',
  ].join('\n'), { path: 'concepts/retrieval-evidence-contract.md' });
}

function clueNotes(warnings: string[]): string[] {
  return warnings.filter((warning) => warning.startsWith('clue_first_'));
}

describe('clue-first probe config flag', () => {
  test('retrieval_clue_first_probe defaults to false', () => {
    const config = resolveConfig({ engine: 'sqlite', database_path: '/tmp/brain.db' });
    expect(config.retrieval_clue_first_probe).toBe(false);
  });

  test('loads clue-first probe flag from the documented nested retrieval config', () => {
    const config = resolveConfig({
      engine: 'sqlite',
      database_path: '/tmp/brain.db',
      retrieval: { clue_first_probe: true },
    });
    expect(config.retrieval_clue_first_probe).toBe(true);
  });

  test('production wiring enables the lane without wiring any clue generator', () => {
    const config = resolveConfig({
      engine: 'sqlite',
      database_path: '/tmp/brain.db',
      retrieval: { clue_first_probe: true },
    });
    const dependencies = createProductionRetrieveContextDependencies({} as BrainEngine, config);
    expect(dependencies.clueFirstProbe).toBe(true);
    expect(dependencies.clueGenerator).toBeUndefined();
  });

  test('production wiring leaves the lane off by default', () => {
    const config = resolveConfig({ engine: 'sqlite', database_path: '/tmp/brain.db' });
    const dependencies = createProductionRetrieveContextDependencies({} as BrainEngine, config);
    expect(dependencies.clueFirstProbe).toBeUndefined();
    expect(dependencies.clueGenerator).toBeUndefined();
  });
});

describe('clue-first probe lane', () => {
  test('flag off: the generator is never called even on a weak pool', async () => {
    await withEngine('flag-off', async (engine) => {
      await seedCorpus(engine);
      const calls: string[] = [];
      let generatorCalls = 0;

      const result = await retrieveContext(engine, { query: WEAK_QUERY, persist_trace: false }, {
        candidateSearch: makeCandidateSearch(calls),
        clueGenerator: async () => {
          generatorCalls += 1;
          return CLUE_TEXT;
        },
      });

      expect(generatorCalls).toBe(0);
      expect(clueNotes(result.warnings)).toEqual([]);
      expect(calls).not.toContain(CLUE_TEXT);
    });
  });

  test('flag on without a generator: lane skips with an honest disclosure note', async () => {
    await withEngine('no-generator', async (engine) => {
      await seedCorpus(engine);
      const calls: string[] = [];

      const result = await retrieveContext(engine, { query: WEAK_QUERY, persist_trace: false }, {
        candidateSearch: makeCandidateSearch(calls),
        clueFirstProbe: true,
      });

      const notes = clueNotes(result.warnings);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('clue_first_probe_skipped');
      expect(notes[0]).toContain('no clue generator');
      // No extra search variant beyond the deterministic base expansion.
      expect(calls.filter((call) => call === CLUE_TEXT)).toEqual([]);
    });
  });

  test('flag on with generator and weak pool: clue runs as one extra fused variant', async () => {
    await withEngine('weak-pool', async (engine) => {
      await seedCorpus(engine);
      const calls: string[] = [];
      const generatorContexts: { query: string; compiledSnippets: string[] }[] = [];

      const result = await retrieveContext(engine, { query: WEAK_QUERY, persist_trace: false }, {
        candidateSearch: makeCandidateSearch(calls),
        clueFirstProbe: true,
        clueGenerator: async (context) => {
          generatorContexts.push(context);
          return CLUE_TEXT;
        },
      });

      // Generator was called exactly once with the compiled truth already retrieved.
      expect(generatorContexts).toHaveLength(1);
      expect(generatorContexts[0]!.query).toBe(WEAK_QUERY);
      expect(generatorContexts[0]!.compiledSnippets).toContain(MEMORY_INBOX_RESULT.chunk_text);

      // The clue executed as exactly one extra search variant.
      expect(calls.filter((call) => call === CLUE_TEXT)).toHaveLength(1);

      // Clue-lane results were fused into the candidate pool.
      const slugs = result.candidates.map((candidate) => candidate.read_selector.slug);
      expect(slugs).toContain('concepts/provenance-tracing');
      expect(slugs).toContain('concepts/memory-inbox');

      // Honest disclosure of the lane.
      const notes = clueNotes(result.warnings);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('clue_first_variant_used');
      expect(notes[0]).toContain('never answer evidence');

      // The clue text itself never surfaces as answer evidence.
      expect(JSON.stringify(result.candidates)).not.toContain(CLUE_TEXT);
      expect(JSON.stringify(result.required_reads)).not.toContain(CLUE_TEXT);
      expect(result.answer_trust_footer?.authority_class).toBe('not_answer_evidence');
    });
  });

  test('strong pool: the generator is not called', async () => {
    await withEngine('strong-pool', async (engine) => {
      await seedCorpus(engine);
      const calls: string[] = [];
      let generatorCalls = 0;

      const result = await retrieveContext(engine, { query: STRONG_QUERY, persist_trace: false }, {
        candidateSearch: makeCandidateSearch(calls),
        clueFirstProbe: true,
        clueGenerator: async () => {
          generatorCalls += 1;
          return CLUE_TEXT;
        },
      });

      expect(generatorCalls).toBe(0);
      expect(clueNotes(result.warnings)).toEqual([]);
      expect(result.candidates.map((candidate) => candidate.read_selector.slug))
        .toContain('concepts/retrieval-evidence-contract');
    });
  });

  test('generator failure falls back deterministically with a skip note', async () => {
    await withEngine('generator-failure', async (engine) => {
      await seedCorpus(engine);
      const calls: string[] = [];

      const result = await retrieveContext(engine, { query: WEAK_QUERY, persist_trace: false }, {
        candidateSearch: makeCandidateSearch(calls),
        clueFirstProbe: true,
        clueGenerator: async () => {
          throw new Error('runner unavailable');
        },
      });

      const notes = clueNotes(result.warnings);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('clue_first_probe_skipped');
      expect(calls.filter((call) => call === CLUE_TEXT)).toEqual([]);
      expect(result.candidates.map((candidate) => candidate.read_selector.slug))
        .toContain('concepts/memory-inbox');
    });
  });

  test('generator returning null skips the lane with a note', async () => {
    await withEngine('generator-null', async (engine) => {
      await seedCorpus(engine);
      const calls: string[] = [];

      const result = await retrieveContext(engine, { query: WEAK_QUERY, persist_trace: false }, {
        candidateSearch: makeCandidateSearch(calls),
        clueFirstProbe: true,
        clueGenerator: async () => null,
      });

      const notes = clueNotes(result.warnings);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('clue_first_probe_skipped');
      expect(calls.filter((call) => call === CLUE_TEXT)).toEqual([]);
    });
  });

  test('clue lane is deterministic for identical inputs and generator output', async () => {
    await withEngine('determinism', async (engine) => {
      await seedCorpus(engine);
      const run = async () => {
        const result = await retrieveContext(engine, { query: WEAK_QUERY, persist_trace: false }, {
          candidateSearch: makeCandidateSearch([]),
          clueFirstProbe: true,
          clueGenerator: async () => CLUE_TEXT,
        });
        return {
          candidates: result.candidates.map((candidate) => candidate.read_selector.selector_id),
          required_reads: result.required_reads.map((selector) => selector.selector_id),
          warnings: result.warnings,
        };
      };

      const first = await run();
      const second = await run();
      expect(second).toEqual(first);
    });
  });
});
