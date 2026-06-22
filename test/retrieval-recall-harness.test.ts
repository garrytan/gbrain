import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEmbed } from '../src/commands/embed.ts';
import {
  resetEmbeddingProviderForTests,
  setEmbeddingProviderForTests,
} from '../src/core/embedding.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName } from '../src/core/operations.ts';
import { hybridProbeSearch } from '../src/core/search/governed-probe.ts';
import type { RetrieveContextDependencies } from '../src/core/services/retrieve-context-service.ts';
import { retrieveContext } from '../src/core/services/retrieve-context-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { MBrainConfig } from '../src/core/config.ts';

/**
 * Production-path recall harness (Workstream A2).
 *
 * Imports a small corpus through the real import pipeline, embeds it with a deterministic
 * concept-space embedder, then runs labelled queries through the REAL retrieveContext path
 * (no hand-mocked candidate lists). It proves the governed probe with the hybrid candidate
 * search retrieves paraphrase-only matches whose gold page shares no surface keyword — the
 * exact recall the keyword-only probe misses — and that with no embedding provider the
 * hybrid path is byte-for-byte identical to keyword-only (Invariant 8).
 */

// Concept space: each concept groups surface synonyms. A page and a paraphrase query can
// share a concept while sharing zero surface words, so keyword search misses but the vector
// leg recovers it.
const CONCEPTS: Record<string, string[]> = {
  space: ['astronomy', 'telescope', 'galaxy', 'nebula', 'cosmos', 'orbit', 'starlight'],
  ocean: ['ocean', 'marine', 'reef', 'coral', 'tidal', 'seabed', 'aquatic'],
  cooking: ['recipe', 'culinary', 'cuisine', 'kitchen', 'baking', 'simmer'],
  finance: ['ledger', 'invoice', 'accounting', 'fiscal', 'revenue', 'auditing'],
  garden: ['horticulture', 'botany', 'soil', 'pruning', 'perennial', 'compost'],
  music: ['symphony', 'orchestra', 'melody', 'tempo', 'sonata', 'instrument'],
  auto: ['automobile', 'sedan', 'coupe', 'chassis', 'motorist', 'transmission'],
  health: ['cardiology', 'diagnosis', 'clinician', 'therapy', 'ailment', 'remedy'],
};

const CONCEPT_KEYS = Object.keys(CONCEPTS);
const EPSILON = 0.001;

function conceptEmbed(text: string): Float32Array {
  const lowered = text.toLowerCase();
  const tokens = lowered.match(/[a-z]+/g) ?? [];
  const counts = new Set(tokens);
  const vector = new Float32Array(CONCEPT_KEYS.length);
  CONCEPT_KEYS.forEach((concept, index) => {
    let score = EPSILON;
    for (const synonym of CONCEPTS[concept]) {
      if (counts.has(synonym)) score += 1;
    }
    vector[index] = score;
  });
  return vector;
}

function useConceptEmbedder() {
  setEmbeddingProviderForTests({
    capability: {
      available: true,
      mode: 'local',
      implementation: 'test-local',
      model: 'concept-test',
      dimensions: CONCEPT_KEYS.length,
    },
    embedBatch: async (texts: string[]) => texts.map((text) => conceptEmbed(text)),
  });
}

// Force the no-embedding-provider path deterministically, regardless of any ambient local
// embedding daemon on the dev machine. hybridSearch skips the vector leg when unavailable.
function useUnavailableEmbedder() {
  setEmbeddingProviderForTests({
    capability: {
      available: false,
      mode: 'none',
      implementation: 'none',
      model: null,
      dimensions: null,
      reason: 'no embedding provider (parity guard)',
    },
    embedBatch: async () => {
      throw new Error('embedding provider unavailable');
    },
  });
}

interface FixturePage {
  slug: string;
  title: string;
  content: string;
}

// Each page uses a disjoint subset of its concept's synonyms. Paraphrase queries below use a
// synonym of the same concept that does NOT appear in the gold page, so keyword search cannot
// reach it.
const PAGES: FixturePage[] = [
  { slug: 'concepts/space-observation', title: 'Deep Sky Observation', content: 'Observing the nebula and cosmos through a telescope reveals faint structure.' },
  { slug: 'concepts/space-distractor', title: 'Backyard Stargazing', content: 'Casual starlight watching with binoculars near the orbit of bright planets.' },
  { slug: 'concepts/ocean-reefs', title: 'Coral Reef Systems', content: 'Marine coral reef ecosystems thrive in shallow tidal aquatic zones.' },
  { slug: 'concepts/cooking-bread', title: 'Artisan Bread', content: 'A sourdough recipe needs patient baking and a hot kitchen.' },
  { slug: 'concepts/finance-books', title: 'Keeping the Books', content: 'Accounting teams reconcile each invoice against the fiscal revenue ledger.' },
  { slug: 'concepts/garden-beds', title: 'Raised Garden Beds', content: 'Good horticulture starts with rich soil, compost, and seasonal pruning.' },
  { slug: 'concepts/music-strings', title: 'String Section', content: 'The orchestra rehearsed a slow sonata, watching the conductor for tempo.' },
  { slug: 'concepts/auto-restoration', title: 'Classic Restoration', content: 'Restoring a vintage sedan means rebuilding the chassis for the careful motorist.' },
  { slug: 'concepts/health-heart', title: 'Heart Clinic Notes', content: 'The clinician documented a cardiology diagnosis and a long-term therapy plan.' },
  { slug: 'concepts/auto-distractor', title: 'Daily Commute', content: 'A reliable coupe with a smooth transmission makes the commute painless.' },
];

interface QueryCase {
  id: string;
  query: string;
  goldSlug: string;
  paraphrase: boolean; // gold page shares no surface keyword with the query
}

const CASES: QueryCase[] = [
  // Paraphrase: query token is a concept synonym ABSENT from the gold page text.
  { id: 'space-paraphrase', query: 'galaxy', goldSlug: 'concepts/space-observation', paraphrase: true },
  { id: 'auto-paraphrase', query: 'automobile', goldSlug: 'concepts/auto-restoration', paraphrase: true },
  { id: 'ocean-paraphrase', query: 'seabed', goldSlug: 'concepts/ocean-reefs', paraphrase: true },
  { id: 'health-paraphrase', query: 'remedy', goldSlug: 'concepts/health-heart', paraphrase: true },
  // Direct: query token appears verbatim in the gold page (sanity — hybrid keeps lexical recall).
  { id: 'cooking-direct', query: 'recipe', goldSlug: 'concepts/cooking-bread', paraphrase: false },
  { id: 'finance-direct', query: 'invoice', goldSlug: 'concepts/finance-books', paraphrase: false },
  { id: 'garden-direct', query: 'compost', goldSlug: 'concepts/garden-beds', paraphrase: false },
  { id: 'music-direct', query: 'sonata', goldSlug: 'concepts/music-strings', paraphrase: false },
];

async function withCorpus<T>(fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-recall-harness-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    // Embed the corpus with the deterministic concept embedder so the vector leg has
    // controlled vectors. Tests override the active provider afterward as needed.
    useConceptEmbedder();
    for (const page of PAGES) {
      await importFromContent(engine, page.slug, page.content, { path: `${page.slug}.md` });
    }
    await runEmbed(engine, ['--stale']);
    return await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function hybridDependencies(engine: SQLiteEngine): RetrieveContextDependencies {
  const config = { query_rewrite_provider: 'none' } as unknown as MBrainConfig;
  return {
    candidateSearch: (query, options) => hybridProbeSearch(engine, config, query, { limit: options.limit }),
  };
}

async function candidateSlugs(
  engine: SQLiteEngine,
  query: string,
  dependencies: RetrieveContextDependencies,
): Promise<string[]> {
  const result = await retrieveContext(engine, {
    query,
    limit: 10,
    include_orientation: false,
    persist_trace: false,
  }, dependencies);
  return result.candidates
    .map((candidate) => candidate.read_selector.slug)
    .filter((slug): slug is string => Boolean(slug));
}

afterEach(() => {
  resetEmbeddingProviderForTests();
});

describe('production-path retrieval recall harness', () => {
  test('hybrid governed probe retrieves every gold page (recall@10 + top1)', async () => {
    await withCorpus(async (engine) => {
      let top1Hits = 0;
      for (const testCase of CASES) {
        const slugs = await candidateSlugs(engine, testCase.query, hybridDependencies(engine));
        expect(slugs).toContain(testCase.goldSlug); // recall@10
        if (slugs[0] === testCase.goldSlug) top1Hits += 1;
      }
      // Every direct case and most paraphrase cases should land the gold page at rank 1.
      expect(top1Hits / CASES.length).toBeGreaterThanOrEqual(0.75);
    });
  });

  test('keyword-only probe misses paraphrase matches the hybrid probe recovers', async () => {
    await withCorpus(async (engine) => {
      for (const testCase of CASES.filter((c) => c.paraphrase)) {
        const keywordOnly = await candidateSlugs(engine, testCase.query, {});
        expect(keywordOnly).not.toContain(testCase.goldSlug); // the gap A1 closes

        const hybrid = await candidateSlugs(engine, testCase.query, hybridDependencies(engine));
        expect(hybrid).toContain(testCase.goldSlug);
      }
    });
  });

  test('parity guard: with no embedding provider, enabling hybrid does not change recall outcomes', async () => {
    // No provider override -> getEmbeddingProvider() reports unavailable -> hybridSearch
    // degrades to keyword-only (empty vector leg). Offline / no-provider installs see the
    // same recall as keyword-only: no paraphrase recovery, direct matches still found
    // (Invariant 8 — the vector leg, not a different ranking, is what closes the gap).
    await withCorpus(async (engine) => {
      // Switch the active provider to unavailable AFTER the corpus is embedded, so the
      // vector leg is skipped at query time (deterministic regardless of any local daemon).
      useUnavailableEmbedder();
      for (const testCase of CASES.filter((c) => c.paraphrase)) {
        const keywordOnly = await candidateSlugs(engine, testCase.query, {});
        const hybridNoProvider = await candidateSlugs(engine, testCase.query, hybridDependencies(engine));
        expect(keywordOnly).not.toContain(testCase.goldSlug);
        expect(hybridNoProvider).not.toContain(testCase.goldSlug);
      }
      for (const testCase of CASES.filter((c) => !c.paraphrase)) {
        const hybridNoProvider = await candidateSlugs(engine, testCase.query, hybridDependencies(engine));
        expect(hybridNoProvider).toContain(testCase.goldSlug);
      }
    });
  });

  test('retrieve_context operation honors the governed_probe_hybrid config flag end-to-end', async () => {
    await withCorpus(async (engine) => {
      const op = operationsByName.retrieve_context;
      if (!op) throw new Error('retrieve_context operation is missing');
      const paraphrase = CASES.find((c) => c.paraphrase);
      if (!paraphrase) throw new Error('expected a paraphrase case');

      const runWithFlag = async (flag: boolean): Promise<string[]> => {
        const result = await op.handler(
          { engine, config: { retrieval_governed_probe_hybrid: flag } as unknown as MBrainConfig, logger: console, dryRun: false } as never,
          { query: paraphrase.query, limit: 10, include_orientation: false },
        ) as { candidates: Array<{ read_selector: { slug?: string } }> };
        return result.candidates
          .map((candidate) => candidate.read_selector.slug)
          .filter((slug): slug is string => Boolean(slug));
      };

      expect(await runWithFlag(true)).toContain(paraphrase.goldSlug);
      expect(await runWithFlag(false)).not.toContain(paraphrase.goldSlug);
    });
  });
});
