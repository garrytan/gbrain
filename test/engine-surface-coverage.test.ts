/**
 * Plan D9 — BrainEngine surface-coverage sweep (mechanical, shrink-only).
 *
 * Three layers, all runtime-enumerated (no TypeScript type machinery):
 *
 *  1. INTERFACE_METHODS is the checked-in literal list of every method on the
 *     `BrainEngine` interface (src/core/engine.ts). It is asserted BOTH ways
 *     against `Object.getOwnPropertyNames(PGLiteEngine.prototype)`: every
 *     listed method must exist on the prototype, and every non-private
 *     prototype member must be classified (interface method or pinned
 *     internal helper). A new engine method therefore forces a visible,
 *     reviewable edit to one of these lists.
 *
 *  2. The UNCALLED allowlist is SHRINK-ONLY. At runtime the test scans every
 *     other file under test/ for a reference to each interface method
 *     (`.name(`, `.name!(`, `.name?.(` call sites, or `name:` stub-property
 *     definitions — the same loose-but-mechanical match a coverage grep
 *     uses; a bare mention in a comment does not count). The set of
 *     methods with ZERO references outside this file must equal UNCALLED
 *     exactly:
 *       - a NEW method with no test anywhere fails ("never-called methods
 *         can't ship") until it either gets a real test or is explicitly
 *         allowlisted + smoked here;
 *       - when real coverage lands elsewhere for an UNCALLED entry, this
 *         test fails until the entry is REMOVED (shrink-only, mechanized).
 *
 *  3. Every UNCALLED entry is smoked ONCE below against a seeded PGLite
 *     engine with a real-shape assertion (not bare no-throw). The SMOKES
 *     map's keys are asserted equal to UNCALLED so an allowlisted method
 *     can't skip its smoke.
 *
 * Known softness (accepted): the corpus scan can false-positive on a
 * `name:` object key that isn't an engine stub. That errs toward "covered"
 * (a stale UNCALLED entry), which the shrink-only equality then flags.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';

const DIM = 1536;

/**
 * Every method declared on the BrainEngine interface (src/core/engine.ts),
 * in declaration order. `kind` (a readonly data property, not a prototype
 * method) is asserted separately on the instance in the smoke block.
 */
const INTERFACE_METHODS: readonly string[] = [
  // Lifecycle
  'connect', 'disconnect', 'reconnect', 'initSchema', 'transaction', 'withReservedConnection',
  // Pages CRUD
  'getPage', 'putPage', 'findDuplicatePage', 'deletePage', 'deletePages', 'resolveSlugsByPaths',
  'softDeletePage', 'softDeletePages', 'restorePage', 'purgeDeletedPages', 'listPages', 'resolveSlugs', 'getAllSlugs',
  'listAllPageRefs', 'listAllSources', 'updateSourceConfig', 'listPrefixSampledPages', 'listCorpusSample',
  // Search
  'searchKeyword', 'searchTitles', 'searchVector', 'getEmbeddingsByChunkIds',
  // Chunks
  'upsertChunks', 'getChunks', 'countStaleChunks', 'sumStaleChunkChars', 'setPageEmbeddingSignature',
  'invalidateStaleSignatureEmbeddings', 'invalidateContentDriftEmbeddings', 'listStaleChunks',
  'countChunklessPagesWithContent', 'listChunklessPagesWithContent', 'deleteChunks',
  // Extraction watermark
  'countStalePagesForExtraction', 'listStalePagesForExtraction', 'markPagesExtractedBatch',
  // Links + graph
  'addLink', 'addLinksBatch', 'removeLink', 'getLinks', 'getBacklinks', 'listLinkSources',
  'findByTitleFuzzy', 'traverseGraph', 'traversePaths', 'relationalFanout', 'getBacklinkCounts',
  'getAdjacencyBoosts', 'getContentFlagsByPageIds', 'getUnverifiedExtractionPageIds',
  'getPageTimestamps', 'getEffectiveDates', 'getSalienceScores', 'findOrphanPages',
  // Tags
  'addTag', 'removeTag', 'getTags',
  // Timeline + chronicle
  'addTimelineEntry', 'addTimelineEntriesBatch', 'getTimeline', 'getTimelineForDate', 'getSince',
  'getOnThisDay', 'getLastSeen', 'upsertEventProjection',
  // Ontology
  'mergeOntologyFact', 'getOntology', 'discoverOntologyDimensions', 'findOntologyConflicts',
  // Raw data + files
  'putRawData', 'getRawData', 'upsertFile', 'getFile', 'listFilesForPage',
  // Takes
  'addTakesBatch', 'listTakes', 'searchTakes', 'searchTakesVector', 'getTakeEmbeddings',
  'countStaleTakes', 'listStaleTakes', 'updateTake', 'supersedeTake', 'resolveTake',
  'getScorecard', 'getCalibrationCurve', 'addSynthesisEvidence',
  // Dream verdicts (sweepDreamVerdicts: wave-k #4069 TTL housekeeping,
  // covered by test/dream-verdict-cache-ttl.test.ts)
  'getDreamVerdict', 'putDreamVerdict', 'sweepDreamVerdicts',
  // Contradiction probe
  'listActiveTakesForPages', 'writeContradictionsRun', 'loadContradictionsTrend',
  'getContradictionCacheEntry', 'putContradictionCacheEntry', 'sweepContradictionCache',
  // Facts (hot memory)
  'insertFact', 'insertFacts', 'deleteFactsForPage', 'expireFact', 'listFactsByEntity',
  'listFactsSince', 'listFactsBySession', 'listSupersessions', 'countUnconsolidatedFacts',
  'findCandidateDuplicates', 'consolidateFact', 'findTrajectory', 'getFactsHealth',
  // Versions
  'createVersion', 'getVersions', 'revertToVersion',
  // Stats + health + ingest log
  'getStats', 'getHealth', 'logIngest', 'getIngestLog',
  // Sync + aliases + narrow updates
  'updateSlug', 'rewriteLinks', 'resolveSlugWithAlias', 'resolveAliases', 'setPageAliases',
  'refreshPageBody', 'updatePageContextualRetrievalState', 'migrateFactsToCanonical',
  // Config + migration + raw SQL
  'getConfig', 'setConfig', 'unsetConfig', 'listConfigKeys', 'runMigration',
  'getChunksWithEmbeddings', 'executeRaw', 'executeRawDirect',
  // v0.46.28-34 master waves (classified at the test-gap-wave merge):
  // #3980 bulk config read, #3776 takes-embedding update, #3674 scoped
  // link removal.
  'getAllConfig', 'updateTakeEmbeddings', 'removeLinksByPagesAndSource',
  // Code edges
  'addCodeEdges', 'deleteCodeEdgesForChunks', 'getCallersOf', 'getCalleesOf', 'getEdgesByChunk',
  'searchKeywordChunks',
  // Eval capture
  'logEvalCandidate', 'listEvalCandidates', 'deleteEvalCandidatesBefore', 'logEvalCaptureFailure',
  'listEvalCaptureFailures',
  // Salience + anomaly + enrich
  'batchLoadEmotionalInputs', 'setEmotionalWeightBatch', 'getRecentSalience', 'listEnrichCandidates',
  'findAnomalies',
];

/**
 * Non-interface prototype members that are legitimate engine internals
 * (helpers/getters shared across the peeled engine modules). Names starting
 * with `_` are treated as private implicitly and need no entry here. Adding
 * a new PUBLIC helper requires a row here — a visible review event, same as
 * a new interface method.
 */
const ENGINE_INTERNAL_HELPERS: readonly string[] = [
  'db',
  'applyForwardReferenceBootstrap',
  'getBulkRetryOpts',
  'batchRetry',
  'buildStaleChunkWhere',
  'activeEmbeddingColId',
  'buildChunklessPagesWhere',
  'buildStalePagesWhere',
  'pushChronicleSource',
  'factsDeps',
  'takesDeps',
  'codeEdgesDeps',
  'salienceDeps',
];

/**
 * SHRINK-ONLY allowlist: interface methods with zero references anywhere in
 * test/ outside this file (verified mechanically by the corpus-scan test
 * below). Each entry is smoked once in the SMOKES block. Do NOT add an
 * entry without a smoke; REMOVE an entry as soon as real coverage lands
 * elsewhere (the scan test forces both).
 *
 * Zero-production-caller flags (deletion candidates — maintainer decision,
 * per the coverage-plan D9 spec; smoked here regardless):
 *   - getPageTimestamps: @deprecated since v0.29.1 in favor of
 *     getEffectiveDates; ZERO src/ callers outside the two engines.
 *   - getTakeEmbeddings left the list at the master merge: wave-k's #3776
 *     semantic takes retrieval gave it real callers + coverage (the ratchet
 *     shrank, as designed — its smoke below stays as a shape pin).
 */
const UNCALLED: readonly string[] = [
  'listPrefixSampledPages', // called by src/core/brainstorm/domain-bank.ts; brainstorm tests stub above the engine
  'listCorpusSample',       // called by src/core/brainstorm/domain-bank.ts (fallback arm)
  'getPageTimestamps',      // DELETION CANDIDATE: deprecated, zero src callers
  'rewriteLinks',           // documented no-op stub; callers exist (migrate.ts, cycle/phantom-redirect.ts)
];

function methodNames(): string[] {
  return Object.getOwnPropertyNames(PGLiteEngine.prototype).filter((n) => n !== 'constructor');
}

describe('BrainEngine surface — mechanical enumeration (D9)', () => {
  test('every interface method exists as a function on the PGLite prototype', () => {
    const missing = INTERFACE_METHODS.filter((n) => {
      const d = Object.getOwnPropertyDescriptor(PGLiteEngine.prototype, n);
      return !d || typeof d.value !== 'function';
    });
    expect(missing).toEqual([]);
  });

  test('no unclassified public members on the prototype (new methods must be listed)', () => {
    const unclassified = methodNames().filter(
      (n) =>
        !n.startsWith('_') &&
        !INTERFACE_METHODS.includes(n) &&
        !ENGINE_INTERNAL_HELPERS.includes(n),
    );
    expect(unclassified).toEqual([]);
  });

  test('classification lists carry no stale rows', () => {
    const proto = new Set(methodNames());
    expect(ENGINE_INTERNAL_HELPERS.filter((n) => !proto.has(n))).toEqual([]);
    // UNCALLED must stay a subset of the interface.
    expect(UNCALLED.filter((n) => !INTERFACE_METHODS.includes(n))).toEqual([]);
    // No duplicates in the checked-in lists.
    expect(new Set(INTERFACE_METHODS).size).toBe(INTERFACE_METHODS.length);
    expect(new Set(UNCALLED).size).toBe(UNCALLED.length);
  });

  test('UNCALLED equals the set of methods with zero references in the rest of test/ (shrink-only)', () => {
    const testRoot = import.meta.dir; // <repo>/test
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && p !== import.meta.path) files.push(p);
      }
    })(testRoot);
    // Fail closed if the walk ever breaks — an empty corpus would classify
    // EVERYTHING as uncovered (or, inverted, mask a regression).
    expect(files.length).toBeGreaterThan(500);

    let corpus = '';
    for (const f of files) corpus += readFileSync(f, 'utf8') + '\n';

    const referenced = (name: string): boolean =>
      // `.name(` / `.name!(` call sites, `.name?.(` optional-chain calls,
      // or `name:` stub-property definitions on engine test doubles.
      new RegExp(`[.]${name}\\s*!?\\s*\\(|[.]${name}\\?\\.\\(|\\b${name}\\s*:`).test(corpus);

    const unreferenced = INTERFACE_METHODS.filter((n) => !referenced(n));

    // Two-direction diff for actionable failure output:
    //  - newlyUncovered: add a real test, or allowlist + smoke it here.
    //  - nowCovered: coverage landed elsewhere — SHRINK the UNCALLED list.
    const newlyUncovered = unreferenced.filter((n) => !UNCALLED.includes(n));
    const nowCovered = UNCALLED.filter((n) => !unreferenced.includes(n));
    expect({ newlyUncovered, nowCovered }).toEqual({ newlyUncovered: [], nowCovered: [] });
  });
});

// ============================================================
// Smokes: each UNCALLED method called once against a seeded engine,
// asserting a minimal real-shape invariant.
// ============================================================

let engine: PGLiteEngine;
let fundAPageId: number;
let fundATakeId: number;

function unitEmbedding(): Float32Array {
  const e = new Float32Array(DIM);
  e[0] = 1;
  return e;
}

const SMOKES: Record<string, () => Promise<void>> = {
  listPrefixSampledPages: async () => {
    // One row per two-segment prefix, ordered by prefix; inbound-link count
    // is the tiebreaker inside a prefix; representative_chunk_id resolves to
    // the lowest embedded chunk (null when the page has no embedded chunks).
    const rows = await engine.listPrefixSampledPages({ prefixes: ['wiki/vc', 'wiki/biology'] });
    expect(rows.map((r) => r.prefix)).toEqual(['wiki/biology', 'wiki/vc']);
    const bio = rows[0];
    expect(bio.slug).toBe('wiki/biology/cells');
    expect(bio.source_id).toBe('default');
    expect(bio.connection_count).toBe(0);
    expect(bio.representative_chunk_id).toBeNull();
    const vc = rows[1];
    // fund-b has 1 inbound link (from fund-a) → beats fund-a on the
    // connection_count tiebreak.
    expect(vc.slug).toBe('wiki/vc/fund-b');
    expect(vc.connection_count).toBe(1);
    expect(typeof vc.page_id).toBe('number');
    expect(vc.compiled_truth).toContain('fund b');
    expect(vc.representative_chunk_id).not.toBeNull();
    // Unknown prefix → no row; empty prefix list short-circuits to [].
    expect(await engine.listPrefixSampledPages({ prefixes: ['no/such'] })).toEqual([]);
    expect(await engine.listPrefixSampledPages({ prefixes: [] })).toEqual([]);
  },

  listCorpusSample: async () => {
    const a = await engine.listCorpusSample({ n: 2, seed: 0.42 });
    expect(a).toHaveLength(2);
    for (const row of a) {
      expect(typeof row.slug).toBe('string');
      expect(row.source_id).toBe('default');
      expect(row.page_id).toBeGreaterThan(0);
      expect(typeof row.connection_count).toBe('number');
    }
    // Deterministic under an explicit seed (the documented test contract).
    const b = await engine.listCorpusSample({ n: 2, seed: 0.42 });
    expect(b.map((r) => r.slug)).toEqual(a.map((r) => r.slug));
    // n <= 0 short-circuits without touching the DB.
    expect(await engine.listCorpusSample({ n: 0 })).toEqual([]);
  },

  getPageTimestamps: async () => {
    const ts = await engine.getPageTimestamps(['wiki/vc/fund-a', 'missing/none']);
    expect(ts.size).toBe(1);
    const when = ts.get('wiki/vc/fund-a');
    expect(when).toBeInstanceOf(Date);
    expect(Number.isNaN(when!.getTime())).toBe(false);
    expect(ts.has('missing/none')).toBe(false);
    // Empty input short-circuits to an empty map.
    expect((await engine.getPageTimestamps([])).size).toBe(0);
  },


  rewriteLinks: async () => {
    // Documented no-op stub on PGLite: links key on integer page_id FKs, so
    // they are already correct after updateSlug. Pin the no-op contract —
    // resolves undefined and leaves the link table untouched.
    const before = await engine.getLinks('wiki/vc/fund-a');
    expect(before.length).toBe(1);
    const out = await engine.rewriteLinks('wiki/vc/fund-a', 'wiki/vc/renamed');
    expect(out).toBeUndefined();
    const after = await engine.getLinks('wiki/vc/fund-a');
    expect(after.map((l) => l.to_slug)).toEqual(before.map((l) => l.to_slug));
  },
};

describe('uncovered-method smokes (seeded PGLite)', () => {
  beforeAll(async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: DIM,
      env: { ...process.env },
    });
    engine = new PGLiteEngine();
    await engine.connect({}); // in-memory
    await engine.initSchema();

    const fundA = await engine.putPage('wiki/vc/fund-a', {
      type: 'note',
      title: 'Fund A',
      compiled_truth: 'about fund a.',
    });
    fundAPageId = fundA.id;
    await engine.putPage('wiki/vc/fund-b', { type: 'note', title: 'Fund B', compiled_truth: 'about fund b.' });
    await engine.putPage('wiki/biology/cells', { type: 'note', title: 'Cells', compiled_truth: 'about cells.' });
    // fund-b gets one inbound link → the prefix-sampling tiebreaker target.
    await engine.addLink('wiki/vc/fund-a', 'wiki/vc/fund-b');
    // One embedded chunk on fund-b → representative_chunk_id is non-null.
    await engine.upsertChunks('wiki/vc/fund-b', [
      {
        chunk_index: 0,
        chunk_text: 'about fund b.',
        chunk_source: 'compiled_truth',
        embedding: unitEmbedding(),
        token_count: 3,
      },
    ]);
    // One take with a hand-written embedding for getTakeEmbeddings.
    await engine.addTakesBatch([
      { page_id: fundAPageId, row_num: 1, claim: 'Fund A is focused', kind: 'take', holder: 'world', weight: 0.7 },
    ]);
    const [take] = await engine.listTakes({ page_id: fundAPageId });
    fundATakeId = take.id;
    const vecStr = '[' + Array.from(unitEmbedding()).join(',') + ']';
    await engine.executeRaw(`UPDATE takes SET embedding = $1::vector, embedded_at = now() WHERE id = $2`, [
      vecStr,
      fundATakeId,
    ]);
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('kind discriminator (readonly instance property, not on the prototype)', () => {
    expect(engine.kind).toBe('pglite');
  });

  test('smoke map covers exactly the UNCALLED allowlist', () => {
    expect(Object.keys(SMOKES).sort()).toEqual([...UNCALLED].sort());
  });

  for (const name of Object.keys(SMOKES)) {
    test(`smoke: ${name}`, () => SMOKES[name]());
  }

  // getTakeEmbeddings left UNCALLED at the master merge (#3776 gave it real
  // coverage elsewhere); its shape pin stays here, inside the seeded engine's
  // lifecycle, no longer tied to the UNCALLED map.
  test('getTakeEmbeddings shape pin (ex-UNCALLED): Float32Array rehydration + omissions', async () => {
    const embs = await engine.getTakeEmbeddings([fundATakeId, 999_999]);
    expect(embs.size).toBe(1);
    const vec = embs.get(fundATakeId);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec!.length).toBe(DIM);
    expect(vec![0]).toBeCloseTo(1);
    expect((await engine.getTakeEmbeddings([])).size).toBe(0);
  });
});
