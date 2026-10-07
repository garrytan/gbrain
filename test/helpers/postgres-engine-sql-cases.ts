/**
 * Shared PostgresEngine method catalog for the refactor-wave-1 W0 goldens
 * (EO8 SQL text, EO4 RLS scope inventory). Each case drives ONE public engine
 * method (one named option variant) through the recording fake in
 * `fake-postgres-sql.ts` with canned rows, so the method completes and every
 * statement it emits is captured. No database.
 *
 * DOMAIN_OF assigns every PostgresEngine prototype member to one of the 12 W1
 * domains or to an explicit out-of-scope bucket; the classification is itself
 * pinned by `sql-text/_classification.json` so a new method fails until it is
 * classified.
 */

import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { valueHash } from '../../src/core/chronicle/ontology.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { resetFtsLanguageCache } from '../../src/core/fts-language.ts';
import { makeFakeSql, type FakeSql, type RecordedStatement, type Responder } from './fake-postgres-sql.ts';
import { withEnv } from './with-env.ts';
import { LEGACY_EMBEDDING_CONFIG } from './legacy-embedding-config.ts';

export const W1_DOMAINS = [
  'pages', 'links', 'tags', 'timeline', 'sources', 'files',
  'chunks', 'facts', 'takes', 'salience', 'code-edges', 'cjk-search',
] as const;
export type W1Domain = typeof W1_DOMAINS[number];

/**
 * Out-of-scope buckets (not converted in W1). Values are `out-of-scope:<why>`.
 * searchKeyword / searchKeywordChunks are split: their CJK branch is the
 * `cjk-search` domain (cases tagged `#cjk`), the FTS branch is `search`.
 */
const OOS = {
  lifecycle: 'out-of-scope:lifecycle (connection, pool, transaction, raw seams)',
  helper: 'out-of-scope:internal-helper (private; exercised through public callers)',
  search: 'out-of-scope:search (FTS/vector hot paths, dialect-specific, not a W1 domain)',
  enrichment: 'out-of-scope:shared-read-enrichment (already one SQL copy in search/read-enrichment.ts)',
  stats: 'out-of-scope:stats-health (brain-wide aggregates)',
  config: 'out-of-scope:config',
  ingest: 'out-of-scope:ingest-log',
  eval: 'out-of-scope:eval-capture',
  dream: 'out-of-scope:dream-verdicts',
  raw: 'out-of-scope:raw-data',
  stub: 'out-of-scope:no-sql-stub',
} as const;

export const DOMAIN_OF: Record<string, string> = {
  'constructor': OOS.lifecycle,
  'registerBeforeDisconnect': OOS.lifecycle,
  'sql': OOS.lifecycle,
  'engineSql': OOS.helper,
  'engineSqlOn': OOS.helper,
  'rlsScopeBindingEnabled': OOS.helper,
  'withScopedReadTransaction': OOS.helper,
  'connect': OOS.lifecycle,
  'disconnect': OOS.lifecycle,
  'disconnectInternal': OOS.helper,
  'initSchema': OOS.lifecycle,
  'applyForwardReferenceBootstrap': OOS.helper,
  'transaction': OOS.lifecycle,
  'transactionDirect': OOS.lifecycle,
  'transactionOn': OOS.helper,
  'withReservedConnection': OOS.lifecycle,
  'getPoolDiagnostics': OOS.lifecycle,
  'onCheckout': OOS.lifecycle,
  'reconnect': OOS.lifecycle,
  'runUnsafe': OOS.helper,
  'executeRaw': OOS.lifecycle,
  'executeRawDirect': OOS.lifecycle,
  'runMigration': OOS.lifecycle,
  'getBulkRetryOpts': OOS.helper,
  'batchRetry': OOS.helper,
  'connRetry': OOS.helper,
  'resolveFactsEmbeddingCast': OOS.helper,
  'activeEmbeddingColId': OOS.helper,
  '_upsertChunksOnce': OOS.helper,
  '_searchKeywordCJK': OOS.helper,
  'runVectorAttempt': OOS.helper,
  'vectorIterativeScanSupported': OOS.helper,

  // pages
  'getPage': 'pages', 'readPageSnapshot': 'pages', 'lockPageKeys': 'pages', 'findDuplicatePage': 'pages',
  'putPage': 'pages', 'deletePage': 'pages', 'deletePages': 'pages', 'resolveSlugsByPaths': 'pages',
  'softDeletePage': 'pages', 'softDeletePages': 'pages', 'restorePage': 'pages', 'purgeDeletedPages': 'pages',
  'refreshPageBody': 'pages', 'updatePageContextualRetrievalState': 'pages', 'listPages': 'pages',
  'getAllSlugs': 'pages', 'listAllPageRefs': 'pages', 'listPrefixSampledPages': 'pages', 'listCorpusSample': 'pages',
  'resolveSlugs': 'pages', 'findByTitleFuzzy': 'pages', 'getPageTimestamps': 'pages',
  'createVersion': 'pages', 'getVersions': 'pages', 'revertToVersion': 'pages', 'updateSlug': 'pages',
  'resolveSlugWithAlias': 'pages', 'resolveSlugWithAliasDetailed': 'pages', 'setPageAliases': 'pages',
  'countStalePagesForExtraction': 'pages', 'listStalePagesForExtraction': 'pages', 'markPagesExtractedBatch': 'pages',
  'markPagesAttendanceBlocked': 'pages',
  // links
  'addLink': 'links', 'addLinksBatch': 'links', 'replaceDerivedLinks': 'links', 'removeLinksByPagesAndSource': 'links',
  'removeLink': 'links', 'getLinks': 'links', 'getBacklinks': 'links', 'listLinkSources': 'links',
  'traverseGraph': 'links', 'traversePaths': 'links', 'traversePathsDetailed': 'links', 'findOrphanPages': 'links',
  'rewriteLinks': OOS.stub,
  // tags
  'addTag': 'tags', 'removeTag': 'tags', 'getTags': 'tags',
  // timeline
  'addTimelineEntry': 'timeline', 'addTimelineEntriesBatch': 'timeline', 'getTimeline': 'timeline',
  'getTimelineForDate': 'timeline', 'getSince': 'timeline', 'getOnThisDay': 'timeline', 'getLastSeen': 'timeline',
  'upsertEventProjection': 'timeline',
  // sources
  'listAllSources': 'sources', 'updateSourceConfig': 'sources',
  // files
  'upsertFile': 'files', 'getFile': 'files', 'listFilesForPage': 'files',
  // chunks
  'upsertChunks': 'chunks', 'getChunks': 'chunks', 'getChunkWindows': 'chunks', 'countStaleChunks': 'chunks', 'sumStaleChunkChars': 'chunks',
  'setPageEmbeddingSignature': 'chunks', 'invalidateStaleSignatureEmbeddings': 'chunks',
  'invalidateContentDriftEmbeddings': 'chunks', 'listStaleChunks': 'chunks',
  'countChunklessPagesWithContent': 'chunks', 'listChunklessPagesWithContent': 'chunks', 'deleteChunks': 'chunks',
  'getEmbeddingsByChunkIds': 'chunks', 'getChunksWithEmbeddings': 'chunks',
  // facts (incl. the ontology rows of the facts table)
  'insertFact': 'facts', 'expireFact': 'facts', 'insertFacts': 'facts', 'deleteFactsForPage': 'facts',
  'listFactsByEntity': 'facts', 'listFactsSince': 'facts', 'listFactsKeyset': 'facts', 'listFactsBySession': 'facts', 'listSupersessions': 'facts',
  'countUnconsolidatedFacts': 'facts', 'findCandidateDuplicates': 'facts', 'consolidateFact': 'facts',
  'findTrajectory': 'facts', 'getFactsHealth': 'facts', 'migrateFactsToCanonical': 'facts',
  'mergeOntologyFact': 'facts', 'getOntology': 'facts', 'discoverOntologyDimensions': 'facts', 'findOntologyConflicts': 'facts',
  // takes (incl. contradictions + synthesis evidence, peeled in postgres-engine/takes.ts)
  'addTakesBatch': 'takes', 'listActiveTakesForPages': 'takes', 'writeContradictionsRun': 'takes',
  'loadContradictionsTrend': 'takes', 'getContradictionCacheEntry': 'takes', 'putContradictionCacheEntry': 'takes',
  'sweepContradictionCache': 'takes', 'listTakes': 'takes', 'searchTakes': 'takes', 'searchTakesVector': 'takes',
  'getTakeEmbeddings': 'takes', 'countStaleTakes': 'takes', 'listStaleTakes': 'takes', 'updateTakeEmbeddings': 'takes',
  'updateTake': 'takes', 'supersedeTake': 'takes', 'resolveTake': 'takes', 'getScorecard': 'takes',
  'getCalibrationCurve': 'takes', 'addSynthesisEvidence': 'takes',
  // salience
  'batchLoadEmotionalInputs': 'salience', 'setEmotionalWeightBatch': 'salience', 'getRecentSalience': 'salience',
  'listEnrichCandidates': 'salience', 'findAnomalies': 'salience',
  // code-edges
  'addCodeEdges': 'code-edges', 'deleteCodeEdgesForChunks': 'code-edges', 'getCallersOf': 'code-edges',
  'getCalleesOf': 'code-edges', 'getEdgesByChunk': 'code-edges',
  // cjk-search: the CJK branch of the two keyword methods (cases tagged #cjk)
  'searchKeyword': 'cjk-search', 'searchKeywordChunks': 'cjk-search',

  // out of scope
  'searchTitles': OOS.search, 'countKeywordPages': OOS.search, 'searchKeywordPages': OOS.search, 'searchVector': OOS.search, 'explainVectorSearch': OOS.search,
  'relationalFanout': OOS.enrichment, 'relationalChainHop': OOS.enrichment, 'getBacklinkCounts': OOS.enrichment, 'getAdjacencyBoosts': OOS.enrichment,
  'getContentFlagsByPageIds': OOS.enrichment, 'getUnverifiedExtractionPageIds': OOS.enrichment,
  'getEffectiveDates': OOS.enrichment, 'getSalienceScores': OOS.enrichment, 'resolveAliases': OOS.enrichment,
  'getStats': OOS.stats, 'getHealth': OOS.stats,
  'getConfig': OOS.config, 'setConfig': OOS.config, 'unsetConfig': OOS.config, 'listConfigKeys': OOS.config, 'getAllConfig': OOS.config,
  'logIngest': OOS.ingest, 'getIngestLog': OOS.ingest,
  'logEvalCandidate': OOS.eval, 'listEvalCandidates': OOS.eval, 'deleteEvalCandidatesBefore': OOS.eval,
  'logEvalCaptureFailure': OOS.eval, 'listEvalCaptureFailures': OOS.eval,
  'getDreamVerdict': OOS.dream, 'putDreamVerdict': OOS.dream, 'sweepDreamVerdicts': OOS.dream,
  'putRawData': OOS.raw, 'getRawData': OOS.raw,
};

/** Every own member of PostgresEngine.prototype (methods + accessors), sorted. */
export function prototypeMembers(): string[] {
  return Object.getOwnPropertyNames(PostgresEngine.prototype).sort();
}

// ─── canned rows ────────────────────────────────────────────────────────

const INCARNATION = '00000000-0000-4000-8000-000000000001';
const REVISION = '00000000-0000-4000-8000-00000000000a';
const EPOCH = new Date(0);
export const PAGE_ROW = {
  id: 1, source_id: 'default', slug: 'people/alice-example', type: 'person', page_kind: 'markdown',
  title: 'Alice Example', compiled_truth: 'Alice Example body.', timeline: '', frontmatter: {},
  content_hash: 'hash-1', created_at: EPOCH, updated_at: EPOCH, deleted_at: null,
  knowledge_revision: REVISION, text_projection_revision: REVISION, effective_date: null, effective_date_source: null,
  import_filename: null, source_kind: null, source_uri: null, ingested_via: null, ingested_at: null,
  updated_at_iso: '1970-01-01T00:00:00.000000Z',
};

type Rule = [RegExp, unknown[] | (() => unknown[])];

/** Rows every case gets unless it overrides the pattern. Order matters (first match wins). */
const DEFAULT_RULES: Rule[] = [
  [/FROM sources WHERE id=\$1 FOR SHARE/, [{ incarnation: INCARNATION }]],
  [/AS snapshot_withdrawals/, [{ ...PAGE_ROW, source_incarnation: INCARNATION, snapshot_tags: [], snapshot_withdrawals: [], fingerprint_body: '', fingerprint_timeline: '' }]],
  [/current_setting\('app\.scopes', true\) AS scopes/, [{ scopes: '*' }]],
  [/^SHOW enable_seqscan$/, [{ enable_seqscan: 'on' }]],
  [/^SHOW statement_timeout$/, [{ statement_timeout: '0' }]],
];

export interface SqlCase {
  method: string;
  /** Named option variant; `default` is the no-options call. */
  variant: string;
  run: (engine: any) => Promise<unknown>;
  /** Extra canned-row rules, checked before the defaults. */
  rows?: Rule[];
}

export function responderFor(rules: Rule[] = []): Responder {
  const all = [...rules, ...DEFAULT_RULES];
  return (stmt: RecordedStatement) => {
    for (const [re, rows] of all) {
      if (re.test(stmt.text)) return typeof rows === 'function' ? rows() : rows;
    }
    return undefined;
  };
}

/** A fresh PostgresEngine wired to a fresh fake (same seam as test/postgres-engine-rls-scope.test.ts). */
export function makeEngineWithFake(rules?: Rule[]): { engine: any; fake: FakeSql } {
  const fake = makeFakeSql(responderFor(rules));
  const engine = new PostgresEngine() as any;
  engine._sql = fake.sql;
  engine._connectionStyle = 'instance';
  return { engine, fake };
}

export interface CaseCapture {
  method: string;
  variant: string;
  trace: FakeSql['trace'];
  result?: string;
  error?: string;
}

/**
 * Pin every process-global input the captured SQL depends on, so a capture is
 * identical whichever test files share the shard process: SQL-shaping env
 * vars, the cached FTS language, and the AI gateway (upsertChunks only issues
 * its `embedding_model` config read when the gateway has no model). The
 * gateway is reset to the preload baseline afterwards.
 */
export async function withPinnedSqlEnvironment<T>(rlsScopeBinding: '1' | undefined, fn: () => Promise<T>): Promise<T> {
  return withEnv({
    GBRAIN_RLS_SCOPE_BINDING: rlsScopeBinding,
    GBRAIN_FTS_LANGUAGE: undefined,
    GBRAIN_SOURCE_BOOST: undefined,
    GBRAIN_SEARCH_EXCLUDE: undefined,
    GBRAIN_REMOTE_PRIVATE_PAGES: undefined,
  }, async () => {
    resetFtsLanguageCache();
    configureGateway({ embedding_model: LEGACY_EMBEDDING_CONFIG.embedding_model, embedding_dimensions: LEGACY_EMBEDDING_CONFIG.embedding_dimensions, env: {} });
    try {
      return await fn();
    } finally {
      resetGateway();
      resetFtsLanguageCache();
    }
  });
}

export async function runCase(c: SqlCase): Promise<CaseCapture> {
  const { engine, fake } = makeEngineWithFake(c.rows);
  try {
    await c.run(engine);
    return { method: c.method, variant: c.variant, trace: fake.trace };
  } catch (e) {
    return { method: c.method, variant: c.variant, trace: fake.trace, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

// ─── the catalog ────────────────────────────────────────────────────────

const SLUG = 'people/alice-example';
const SLUG2 = 'companies/acme-example';
const SRC = 'src-a';
const SRCS = ['src-a', 'src-b'];
const EMB = new Float32Array([0.1, 0.2, 0.3]);
const page = { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example body.', timeline: '', frontmatter: { tags: [] } };
const pageRet: Rule = [/^\s*INSERT INTO pages \(source_id, slug/, [PAGE_ROW]];
const pageId: Rule = [/SELECT id FROM pages/i, [{ id: 1 }]];

function variants(method: string, list: Array<[string, (e: any) => Promise<unknown>, Rule[]?]>): SqlCase[] {
  return list.map(([variant, run, rows]) => ({ method, variant, run, rows }));
}

export const SQL_CASES: SqlCase[] = [
  // ── pages ──
  ...variants('getPage', [
    ['default', (e) => e.getPage(SLUG)],
    ['sourceId', (e) => e.getPage(SLUG, { sourceId: SRC })],
    ['sourceIds', (e) => e.getPage(SLUG, { sourceIds: SRCS })],
    ['includeDeleted', (e) => e.getPage(SLUG, { includeDeleted: true })],
  ]),
  ...variants('readPageSnapshot', [
    ['default', (e) => e.readPageSnapshot(SLUG)],
    ['sourceId', (e) => e.readPageSnapshot(SLUG, { sourceId: SRC })],
  ]),
  ...variants('lockPageKeys', [
    ['default', (e) => e.transaction((tx: any) => tx.lockPageKeys([{ sourceId: SRC, slug: SLUG }]))],
  ]),
  ...variants('findDuplicatePage', [
    ['default', (e) => e.findDuplicatePage(SRC, { hash: 'hash-1' }), [[/FROM pages/, [{ id: 1, slug: SLUG }]]]],
  ]),
  ...variants('putPage', [
    ['default', (e) => e.putPage(SLUG, page), [pageRet]],
    ['blankBody', (e) => e.putPage(SLUG, { ...page, compiled_truth: '' }), [pageRet]],
    ['expectedRevision', (e) => e.putPage(SLUG, page, { expectedRevision: REVISION }), [pageRet]],
  ]),
  ...variants('deletePage', [['default', (e) => e.deletePage(SLUG)]]),
  ...variants('deletePages', [['default', (e) => e.deletePages([SLUG, SLUG2], { sourceId: SRC })]]),
  ...variants('resolveSlugsByPaths', [['default', (e) => e.resolveSlugsByPaths(['people/alice-example.md'], { sourceId: SRC })]]),
  ...variants('softDeletePage', [
    ['default', (e) => e.softDeletePage(SLUG)],
    ['sourceId', (e) => e.softDeletePage(SLUG, { sourceId: SRC })],
  ]),
  ...variants('softDeletePages', [['default', (e) => e.softDeletePages([SLUG], { sourceId: SRC })]]),
  ...variants('restorePage', [
    ['default', (e) => e.restorePage(SLUG)],
    ['sourceId', (e) => e.restorePage(SLUG, { sourceId: SRC })],
  ]),
  ...variants('purgeDeletedPages', [
    ['default', (e) => e.purgeDeletedPages(72)],
    ['dryRun', (e) => e.purgeDeletedPages(72, { dryRun: true })],
  ]),
  ...variants('refreshPageBody', [['default', (e) => e.refreshPageBody(SLUG, SRC, 'body', 'tl', 'hash-2')]]),
  ...variants('updatePageContextualRetrievalState', [['default', (e) => e.updatePageContextualRetrievalState(SLUG, SRC, 'full', 'gen-1')]]),
  ...variants('listPages', [
    ['default', (e) => e.listPages()],
    ['type', (e) => e.listPages({ type: 'person' })],
    ['tag', (e) => e.listPages({ tag: 'founder' })],
    ['updated_after', (e) => e.listPages({ updated_after: '2026-01-01T00:00:00Z' })],
    ['updatedAfterKeyset', (e) => e.listPages({ updatedAfterKeyset: { updatedAt: '2026-01-01T00:00:00.000000Z', slug: SLUG } })],
    ['slugPrefix', (e) => e.listPages({ slugPrefix: 'people/' })],
    ['sourceId', (e) => e.listPages({ sourceId: SRC })],
    ['sourceIds', (e) => e.listPages({ sourceIds: SRCS })],
    ['includeDeleted', (e) => e.listPages({ includeDeleted: true })],
    ['excludePrivate', (e) => e.listPages({ excludePrivate: true })],
    ['effective_after', (e) => e.listPages({ effective_after: '2026-01-01' })],
    ['effective_before', (e) => e.listPages({ effective_before: '2026-01-01' })],
    ['sort', (e) => e.listPages({ sort: 'slug' })],
  ]),
  ...variants('getAllSlugs', [
    ['default', (e) => e.getAllSlugs()],
    ['sourceId', (e) => e.getAllSlugs({ sourceId: SRC })],
  ]),
  ...variants('listAllPageRefs', [['default', (e) => e.listAllPageRefs()]]),
  ...variants('listPrefixSampledPages', [
    ['default', (e) => e.listPrefixSampledPages({ prefixes: ['people/alice-example'] })],
    ['sourceIds', (e) => e.listPrefixSampledPages({ prefixes: ['people/alice-example'], sourceIds: SRCS, staleBias: true })],
  ]),
  ...variants('listCorpusSample', [
    ['default', (e) => e.listCorpusSample({ n: 5 })],
    ['seed', (e) => e.listCorpusSample({ n: 5, seed: 0.5, sourceId: SRC })],
  ]),
  ...variants('resolveSlugs', [
    ['exactHit', (e) => e.resolveSlugs(SLUG), [[/^SELECT slug FROM pages WHERE slug = /, [{ slug: SLUG }]]]],
    ['fuzzy', (e) => e.resolveSlugs('alice')],
    ['sourceId', (e) => e.resolveSlugs('alice', { sourceId: SRC })],
    ['sourceIds', (e) => e.resolveSlugs('alice', { sourceIds: SRCS })],
    ['excludePrivate', (e) => e.resolveSlugs('alice', { excludePrivate: true })],
  ]),
  ...variants('findByTitleFuzzy', [
    ['default', (e) => e.findByTitleFuzzy('Alice Example')],
    ['sourceId', (e) => e.findByTitleFuzzy('Alice Example', 'people', 0.55, SRC)],
    ['lowSimilarity', (e) => e.findByTitleFuzzy('Alice Example', undefined, 0.2)],
  ]),
  ...variants('getPageTimestamps', [['default', (e) => e.getPageTimestamps([SLUG])]]),
  ...variants('createVersion', [
    ['default', (e) => e.createVersion(SLUG), [[/page_versions/, [{ id: 1, page_id: 1, compiled_truth: 'x', frontmatter: {}, snapshot_at: EPOCH }]], pageId]],
  ]),
  ...variants('getVersions', [
    ['default', (e) => e.getVersions(SLUG)],
    ['sourceId', (e) => e.getVersions(SLUG, { sourceId: SRC })],
    ['sourceIds', (e) => e.getVersions(SLUG, { sourceIds: SRCS })],
    ['excludePrivate', (e) => e.getVersions(SLUG, { excludePrivate: true })],
    ['limit', (e) => e.getVersions(SLUG, { sourceId: SRC, limit: 3 })],
    ['metadataOnly', (e) => e.getVersions(SLUG, { sourceIds: SRCS, includeBody: false })],
  ]),
  ...variants('revertToVersion', [
    ['default', (e) => e.revertToVersion(SLUG, 3)],
    ['sourceId', (e) => e.revertToVersion(SLUG, 3, { sourceId: SRC })],
  ]),
  ...variants('updateSlug', [
    ['moved', (e) => e.updateSlug(SLUG, 'people/alice-example-2', { sourceId: SRC }), [[/^UPDATE pages SET slug = \$1/, [{ id: 1 }]]]],
    ['noop', (e) => e.updateSlug(SLUG, 'people/alice-example-2')],
  ]),
  ...variants('resolveSlugWithAlias', [['default', (e) => e.resolveSlugWithAlias('alice', SRC)]]),
  ...variants('resolveSlugWithAliasDetailed', [
    ['default', (e) => e.resolveSlugWithAliasDetailed('alice', SRCS)],
    ['excludePrivate', (e) => e.resolveSlugWithAliasDetailed('alice', SRC, { excludePrivate: true })],
  ]),
  ...variants('setPageAliases', [
    ['default', (e) => e.setPageAliases(SLUG, SRC, ['alice', 'alice example'])],
    ['empty', (e) => e.setPageAliases(SLUG, SRC, [])],
  ]),
  ...variants('countStalePagesForExtraction', [
    ['default', (e) => e.countStalePagesForExtraction()],
    ['versionTs+sourceId', (e) => e.countStalePagesForExtraction({ versionTs: '2026-01-01T00:00:00Z', sourceId: SRC })],
    ['attendance-exclude', (e) => e.countStalePagesForExtraction({ versionTs: '2026-01-01T00:00:00Z', attendance: 'exclude' })],
    ['attendance-blocked+sourceId', (e) => e.countStalePagesForExtraction({ versionTs: '2026-01-01T00:00:00Z', sourceId: SRC, attendance: 'blocked' })],
  ]),
  ...variants('listStalePagesForExtraction', [
    ['default', (e) => e.listStalePagesForExtraction({ batchSize: 10 })],
    ['afterPageId+versionTs+sourceId', (e) => e.listStalePagesForExtraction({ batchSize: 10, afterPageId: 4, versionTs: '2026-01-01T00:00:00Z', sourceId: SRC })],
  ]),
  ...variants('markPagesExtractedBatch', [['default', (e) => e.markPagesExtractedBatch([{ slug: SLUG, source_id: SRC }], '2026-01-01T00:00:00Z')]]),
  ...variants('markPagesAttendanceBlocked', [['default', (e) => e.markPagesAttendanceBlocked([{ slug: SLUG, source_id: SRC, revision: '00000000-0000-4000-8000-000000000001' }])]]),

  // ── links ──
  ...variants('addLink', [
    ['default', (e) => e.addLink(SLUG, SLUG2, 'works at', 'works_at'), [[/WITH endpoint_state/, [{ from_exists: true, to_exists: true }]]]],
  ]),
  ...variants('addLinksBatch', [['default', (e) => e.addLinksBatch([{ from_slug: SLUG, to_slug: SLUG2, link_type: 'works_at' }])]]),
  ...variants('replaceDerivedLinks', [
    ['default', (e) => e.replaceDerivedLinks({ slug: SLUG, sourceId: SRC, expectedRevision: REVISION, sourceIncarnation: INCARNATION }, [{ from_slug: SLUG, to_slug: SLUG2, link_type: 'works_at' }]), [[/INSERT INTO links \(from_page_id, to_page_id, link_type, context, link_source, link_kind/, [{ one: 1 }]]]],
  ]),
  ...variants('removeLinksByPagesAndSource', [
    ['default', (e) => e.removeLinksByPagesAndSource([{ slug: SLUG, source_id: SRC }], { linkSource: 'markdown' })],
  ]),
  ...variants('removeLink', [
    ['default', (e) => e.removeLink(SLUG, SLUG2)],
    ['linkType', (e) => e.removeLink(SLUG, SLUG2, 'works_at')],
    ['linkSource', (e) => e.removeLink(SLUG, SLUG2, undefined, 'markdown')],
    ['linkType+linkSource', (e) => e.removeLink(SLUG, SLUG2, 'works_at', 'markdown')],
  ]),
  ...variants('getLinks', [
    ['default', (e) => e.getLinks(SLUG)],
    ['sourceId', (e) => e.getLinks(SLUG, { sourceId: SRC })],
    ['sourceIds', (e) => e.getLinks(SLUG, { sourceIds: SRCS })],
    ['excludePrivate', (e) => e.getLinks(SLUG, { excludePrivate: true })],
  ]),
  ...variants('getBacklinks', [
    ['default', (e) => e.getBacklinks(SLUG)],
    ['sourceId', (e) => e.getBacklinks(SLUG, { sourceId: SRC })],
    ['sourceIds', (e) => e.getBacklinks(SLUG, { sourceIds: SRCS })],
    ['excludePrivate', (e) => e.getBacklinks(SLUG, { excludePrivate: true })],
  ]),
  ...variants('listLinkSources', [
    ['default', (e) => e.listLinkSources()],
    ['sourceId', (e) => e.listLinkSources({ sourceId: SRC })],
    ['sourceIds', (e) => e.listLinkSources({ sourceIds: SRCS })],
  ]),
  ...variants('traverseGraph', [
    ['default', (e) => e.traverseGraph(SLUG, 2)],
    ['sourceId', (e) => e.traverseGraph(SLUG, 2, { sourceId: SRC })],
    ['sourceIds', (e) => e.traverseGraph(SLUG, 2, { sourceIds: SRCS })],
    ['frontierCap', (e) => e.traverseGraph(SLUG, 2, { frontierCap: 50 })],
    ['excludePrivate', (e) => e.traverseGraph(SLUG, 2, { excludePrivate: true })],
  ]),
  ...variants('traversePaths', [['default', (e) => e.traversePaths(SLUG)]]),
  ...variants('traversePathsDetailed', [
    ['default', (e) => e.traversePathsDetailed(SLUG)],
    ['in', (e) => e.traversePathsDetailed(SLUG, { direction: 'in' })],
    ['both', (e) => e.traversePathsDetailed(SLUG, { direction: 'both' })],
    ['out+sourceId+linkType', (e) => e.traversePathsDetailed(SLUG, { sourceId: SRC, linkType: 'works_at' })],
    ['both+sourceIds+excludePrivate', (e) => e.traversePathsDetailed(SLUG, { direction: 'both', sourceIds: SRCS, excludePrivate: true })],
  ]),
  ...variants('findOrphanPages', [
    ['default', (e) => e.findOrphanPages()],
    ['inbound', (e) => e.findOrphanPages({ mode: 'inbound' })],
    ['sourceId', (e) => e.findOrphanPages({ sourceId: SRC })],
    ['sourceIds+excludePrivate', (e) => e.findOrphanPages({ sourceIds: SRCS, excludePrivate: true })],
  ]),

  // ── tags ──
  ...variants('addTag', [
    ['default', (e) => e.addTag(SLUG, 'founder'), [pageId]],
    ['frontmatter', (e) => e.addTag(SLUG, 'founder', { sourceId: SRC, tagSource: 'frontmatter' }), [pageId]],
  ]),
  ...variants('removeTag', [['default', (e) => e.removeTag(SLUG, 'founder')]]),
  ...variants('getTags', [
    ['default', (e) => e.getTags(SLUG)],
    ['sourceIds', (e) => e.getTags(SLUG, { sourceIds: SRCS })],
    ['excludePrivate+liveOnly', (e) => e.getTags(SLUG, { excludePrivate: true, liveOnly: true })],
  ]),

  // ── timeline ──
  ...variants('addTimelineEntry', [
    ['default', (e) => e.addTimelineEntry(SLUG, { date: '2026-01-02', summary: 'Met Acme Example' }), [[/WITH page_state/, [{ page_exists: true, inserted: true }]]]],
  ]),
  ...variants('addTimelineEntriesBatch', [['default', (e) => e.addTimelineEntriesBatch([{ slug: SLUG, date: '2026-01-02', summary: 'Met Acme Example' }])]]),
  ...variants('getTimeline', [
    ['default', (e) => e.getTimeline(SLUG)],
    ['sourceId', (e) => e.getTimeline(SLUG, { sourceId: SRC })],
    ['sourceIds+after+before', (e) => e.getTimeline(SLUG, { sourceIds: SRCS, after: '2026-01-01', before: '2026-02-01' })],
    ['excludePrivate', (e) => e.getTimeline(SLUG, { excludePrivate: true })],
  ]),
  ...variants('getTimelineForDate', [
    ['default', (e) => e.getTimelineForDate('2026-01-02')],
    ['week+sourceId', (e) => e.getTimelineForDate('2026-01-02', { week: true, sourceId: SRC })],
    ['sourceIds+excludePrivate', (e) => e.getTimelineForDate('2026-01-02', { sourceIds: SRCS, excludePrivate: true })],
    ['excludePrivate', (e) => e.getTimelineForDate('2026-01-02', { excludePrivate: true })],
  ]),
  ...variants('getSince', [
    ['default', (e) => e.getSince('2026-01-02')],
    ['kind+sourceId', (e) => e.getSince('2026-01-02', { kind: 'meeting', sourceId: SRC })],
  ]),
  ...variants('getOnThisDay', [
    ['default', (e) => e.getOnThisDay()],
    ['date+sourceIds', (e) => e.getOnThisDay({ date: '2026-01-02', sourceIds: SRCS })],
  ]),
  ...variants('getLastSeen', [
    ['default', (e) => e.getLastSeen(SLUG)],
    ['asof+sourceId', (e) => e.getLastSeen(SLUG, { asof: '2026-01-02', sourceId: SRC })],
  ]),
  ...variants('upsertEventProjection', [
    ['default', (e) => e.upsertEventProjection({ depthSlug: SLUG, eventSlug: 'events/acme-example-offsite', date: '2026-01-02', summary: 'Offsite' })],
  ]),

  // ── sources ──
  ...variants('listAllSources', [['default', (e) => e.listAllSources()]]),
  ...variants('updateSourceConfig', [['default', (e) => e.updateSourceConfig(SRC, { federated: true })]]),

  // ── files ──
  ...variants('upsertFile', [
    ['default', (e) => e.upsertFile({ filename: 'a.png', storage_path: 'attachments/a.png', content_hash: 'h' }), [[/INSERT INTO files/, [{ id: 1, created: true }]]]],
  ]),
  ...variants('getFile', [['default', (e) => e.getFile(SRC, 'attachments/a.png')]]),
  ...variants('listFilesForPage', [['default', (e) => e.listFilesForPage(1)]]),

  // ── chunks ──
  ...variants('upsertChunks', [
    ['default', (e) => e.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: 'Alice Example body.', chunk_source: 'compiled_truth' }]), [pageId]],
    ['embedding', (e) => e.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: 'Alice Example body.', chunk_source: 'compiled_truth', embedding: EMB, model: 'test-model', embedding_input_hash: 'ih' }], { sourceId: SRC }), [pageId]],
    ['empty', (e) => e.upsertChunks(SLUG, []), [pageId]],
    ['expectedRevision', (e) => e.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth' }], { sourceId: SRC, expectedRevision: REVISION }), [pageId]],
    ['embeddingColumn', (e) => e.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth', embedding: EMB }], { embeddingColumn: { name: 'embedding_voyage', dimensions: 3, embeddingModel: 'voyage-test', vectorType: 'halfvec' } }), [pageId]],
  ]),
  ...variants('getChunks', [
    ['default', (e) => e.getChunks(SLUG)],
    ['sourceIds', (e) => e.getChunks(SLUG, { sourceIds: SRCS })],
    ['includeEmbedding', (e) => e.getChunks(SLUG, { includeEmbedding: true })],
    ['excludePrivate', (e) => e.getChunks(SLUG, { excludePrivate: true })],
    ['includeUnsealed', (e) => e.getChunks(SLUG, { includeUnsealed: true })],
    ['requireSafeChunks', (e) => e.getChunks(SLUG, { requireSafeChunks: true })],
  ]),
  ...variants('countStaleChunks', [
    ['default', (e) => e.countStaleChunks()],
    ['signature+sourceId', (e) => e.countStaleChunks({ signature: 'model:3', sourceId: SRC })],
    ['signature+includeNullSignature', (e) => e.countStaleChunks({ signature: 'model:3', includeNullSignature: true })],
  ]),
  ...variants('sumStaleChunkChars', [
    ['default', (e) => e.sumStaleChunkChars()],
    ['signature', (e) => e.sumStaleChunkChars({ signature: 'model:3' })],
  ]),
  ...variants('setPageEmbeddingSignature', [['default', (e) => e.setPageEmbeddingSignature(SLUG, { signature: 'model:3' })]]),
  ...variants('invalidateStaleSignatureEmbeddings', [
    ['default', (e) => e.invalidateStaleSignatureEmbeddings({ signature: 'model:3' })],
    ['sourceId+includeNullSignature', (e) => e.invalidateStaleSignatureEmbeddings({ signature: 'model:3', sourceId: SRC, includeNullSignature: true })],
  ]),
  ...variants('invalidateContentDriftEmbeddings', [
    ['default', (e) => e.invalidateContentDriftEmbeddings()],
    ['sourceId', (e) => e.invalidateContentDriftEmbeddings({ sourceId: SRC })],
  ]),
  ...variants('listStaleChunks', [
    ['default', (e) => e.listStaleChunks()],
    ['sourceId', (e) => e.listStaleChunks({ sourceId: SRC })],
    ['updated_desc', (e) => e.listStaleChunks({ orderBy: 'updated_desc' })],
    ['updated_desc+cursor', (e) => e.listStaleChunks({ orderBy: 'updated_desc', afterUpdatedAt: '2026-01-01T00:00:00Z', afterPageId: 3, afterChunkIndex: 1 })],
    ['updated_desc+sourceId', (e) => e.listStaleChunks({ orderBy: 'updated_desc', sourceId: SRC })],
    ['updated_desc+sourceId+cursor', (e) => e.listStaleChunks({ orderBy: 'updated_desc', sourceId: SRC, afterUpdatedAt: '2026-01-01T00:00:00Z', afterPageId: 3 })],
  ]),
  ...variants('countChunklessPagesWithContent', [
    ['default', (e) => e.countChunklessPagesWithContent()],
    ['sourceId', (e) => e.countChunklessPagesWithContent({ sourceId: SRC })],
  ]),
  ...variants('listChunklessPagesWithContent', [
    ['default', (e) => e.listChunklessPagesWithContent()],
    ['afterPageId+sourceId', (e) => e.listChunklessPagesWithContent({ afterPageId: 3, sourceId: SRC, batchSize: 5 })],
  ]),
  ...variants('deleteChunks', [['default', (e) => e.deleteChunks(SLUG)]]),
  ...variants('getEmbeddingsByChunkIds', [
    ['default', (e) => e.getEmbeddingsByChunkIds([1, 2])],
    ['column', (e) => e.getEmbeddingsByChunkIds([1, 2], 'embedding_voyage')],
  ]),
  ...variants('getChunkWindows', [
    ['default', (e) => e.getChunkWindows([{ page_id: 1, from_index: 0, to_index: 4, priority: 0 }], { chunkSources: ['compiled_truth', 'timeline'], maxRows: 16 })],
    ['scopedPrivateSafe', (e) => e.getChunkWindows([{ page_id: 1, from_index: 0, to_index: 4, priority: 0 }], { sourceIds: SRCS, excludePrivate: true, requireSafeChunks: true, chunkSources: ['compiled_truth'], maxRows: 16 })],
  ]),
  ...variants('getChunksWithEmbeddings', [
    ['default', (e) => e.getChunksWithEmbeddings(SLUG)],
    ['sourceId+includeUnsealed', (e) => e.getChunksWithEmbeddings(SLUG, { sourceId: SRC, includeUnsealed: true })],
  ]),

  // ── facts ──
  ...variants('insertFact', [
    ['default', (e) => e.insertFact({ fact: 'Alice Example founded Acme Example', entity_slug: SLUG, source: 'cli:test' }, { source_id: SRC }), [[/INSERT INTO facts/, [{ id: 7, status: 'inserted' }]]]],
    ['noEntity', (e) => e.insertFact({ fact: 'A standalone fact', source: 'cli:test' }, { source_id: SRC }), [[/INSERT INTO facts/, [{ id: 7 }]]]],
    ['supersedeId+embedding', (e) => e.insertFact({ fact: 'Alice Example founded Acme Example', entity_slug: SLUG, source: 'cli:test', embedding: EMB, embedding_model: 'test-model' }, { source_id: SRC, supersedeId: 3 }), [[/INSERT INTO facts/, [{ id: 7 }]]]],
  ]),
  ...variants('expireFact', [
    ['default', (e) => e.expireFact(7)],
    ['supersededBy', (e) => e.expireFact(7, { supersededBy: 8, at: EPOCH })],
  ]),
  ...variants('insertFacts', [
    ['default', (e) => e.insertFacts([{ fact: 'f1', source: 'cli:test', entity_slug: SLUG, row_num: 1, source_markdown_slug: SLUG }], { source_id: SRC }), [[/INSERT INTO facts/, [{ id: 7 }]]]],
    ['deleteForPageFirst', (e) => e.insertFacts([{ fact: 'f1', source: 'cli:test', entity_slug: SLUG, row_num: 1, source_markdown_slug: SLUG, superseded_by_row: 2 }, { fact: 'f2', source: 'cli:test', entity_slug: SLUG, row_num: 2, source_markdown_slug: SLUG, embedding: EMB, embedding_model: 'test-model' }], { source_id: SRC }, { deleteForPageFirst: { slug: SLUG, excludeSourcePrefixes: ['cli:'], preserveExpiredLegacy: true } }), [[/INSERT INTO facts/, [{ id: 7 }]]]],
  ]),
  ...variants('deleteFactsForPage', [
    ['default', (e) => e.deleteFactsForPage(SLUG, SRC)],
    ['excludeSourcePrefixes+preserveExpiredLegacy', (e) => e.deleteFactsForPage(SLUG, SRC, { excludeSourcePrefixes: ['cli:'], preserveExpiredLegacy: true })],
  ]),
  ...variants('listFactsByEntity', [
    ['default', (e) => e.listFactsByEntity(SRC, SLUG)],
    ['allFilters', (e) => e.listFactsByEntity(SRC, SLUG, { activeOnly: false, unconsolidatedOnly: true, kinds: ['fact'], visibility: ['world'], excludeAuditRows: true, grep: 'acme' })],
  ]),
  ...variants('listFactsKeyset', [
    ['default', (e) => e.listFactsKeyset(SRC, null)],
    ['strictTime', (e) => e.listFactsKeyset(SRC, { createdAt: '2026-08-10T12:00:00.000100Z', id: null }, { visibility: ['world'] })],
    ['keyset', (e) => e.listFactsKeyset(SRC, { createdAt: '2026-08-10T12:00:00.000100Z', id: 7 }, { activeOnly: false, fingerprint: true, limit: 51 })],
  ]),
  ...variants('listFactsSince', [
    ['default', (e) => e.listFactsSince(SRC, EPOCH)],
    ['allFilters', (e) => e.listFactsSince(SRC, EPOCH, { entitySlug: SLUG, sessionId: 's1', eventTime: true, activeOnly: false, unconsolidatedOnly: true, kinds: ['fact'], visibility: ['world'], excludeAuditRows: true, grep: 'acme' })],
  ]),
  ...variants('listFactsBySession', [
    ['default', (e) => e.listFactsBySession(SRC, 's1')],
    ['allFilters', (e) => e.listFactsBySession(SRC, 's1', { activeOnly: false, unconsolidatedOnly: true, kinds: ['fact'], visibility: ['world'], excludeAuditRows: true, grep: 'acme' })],
  ]),
  ...variants('listSupersessions', [
    ['default', (e) => e.listSupersessions(SRC)],
    ['since+visibility', (e) => e.listSupersessions(SRC, { since: EPOCH, visibility: ['world'] })],
  ]),
  ...variants('countUnconsolidatedFacts', [['default', (e) => e.countUnconsolidatedFacts(SRC)]]),
  ...variants('findCandidateDuplicates', [
    ['default', (e) => e.findCandidateDuplicates(SRC, SLUG, 'Alice Example founded Acme Example')],
    ['embedding', (e) => e.findCandidateDuplicates(SRC, SLUG, 'Alice Example founded Acme Example', { embedding: EMB, embeddingModel: 'test-model' })],
  ]),
  ...variants('consolidateFact', [['default', (e) => e.consolidateFact(7, 9)]]),
  ...variants('findTrajectory', [
    ['default', (e) => e.findTrajectory({ entitySlug: SLUG })],
    ['sourceIds+metric+since+until', (e) => e.findTrajectory({ entitySlug: SLUG, sourceIds: SRCS, metric: 'mrr', kind: 'metric', since: '2026-01-01', until: '2026-06-01', remote: false })],
    ['event', (e) => e.findTrajectory({ entitySlug: SLUG, kind: 'event' })],
  ]),
  ...variants('getFactsHealth', [['default', (e) => e.getFactsHealth(SRC)]]),
  ...variants('migrateFactsToCanonical', [['default', (e) => e.migrateFactsToCanonical('people/alice', SLUG, SRC)]]),
  ...variants('mergeOntologyFact', [
    ['insert', (e) => e.mergeOntologyFact({ entitySlug: SLUG, dimension: 'role', value: 'founder', source: SLUG }), [[/INSERT INTO facts/, [{ id: 7 }]]]],
    ['corroborate', (e) => e.mergeOntologyFact({ entitySlug: SLUG, dimension: 'role', value: 'founder', source: SLUG }), [[/SELECT id, value_hash, valid_from FROM facts/, [{ id: 3, value_hash: valueHash('founder'), valid_from: null }]], [/INSERT INTO facts/, [{ id: 7 }]]]],
    ['supersede', (e) => e.mergeOntologyFact({ entitySlug: SLUG, dimension: 'role', value: 'ceo', source: SLUG }), [[/SELECT id, value_hash, valid_from FROM facts/, [{ id: 3, value_hash: 'other', valid_from: null }]], [/INSERT INTO facts/, [{ id: 7 }]]]],
  ]),
  ...variants('getOntology', [
    ['default', (e) => e.getOntology(SLUG)],
    ['sourceIds+excludePrivate', (e) => e.getOntology(SLUG, { sourceIds: SRCS, excludePrivate: true, asof: '2026-01-01' })],
  ]),
  ...variants('discoverOntologyDimensions', [
    ['default', (e) => e.discoverOntologyDimensions()],
    ['sourceIds', (e) => e.discoverOntologyDimensions({ sourceIds: SRCS })],
  ]),
  ...variants('findOntologyConflicts', [
    ['default', (e) => e.findOntologyConflicts()],
    ['sourceIds+excludePrivate', (e) => e.findOntologyConflicts({ sourceIds: SRCS, excludePrivate: true })],
  ]),

  // ── takes ──
  ...variants('addTakesBatch', [['default', (e) => e.addTakesBatch([{ page_id: 1, row_num: 1, claim: 'Acme Example will grow', kind: 'bet', holder: 'alice-example', weight: 0.7 }])]]),
  ...variants('listActiveTakesForPages', [
    ['default', (e) => e.listActiveTakesForPages([1, 2])],
    ['allowList', (e) => e.listActiveTakesForPages([1], { takesHoldersAllowList: ['alice-example'] })],
  ]),
  ...variants('writeContradictionsRun', [
    ['default', (e) => e.writeContradictionsRun({ run_id: 'r1', judge_model: 'm', prompt_version: 'v1', queries_evaluated: 1, queries_with_contradiction: 0, total_contradictions_flagged: 0, wilson_ci_lower: 0, wilson_ci_upper: 1, judge_errors_total: 0, cost_usd_total: 0, duration_ms: 1, source_tier_breakdown: {}, report_json: {} })],
  ]),
  ...variants('loadContradictionsTrend', [['default', (e) => e.loadContradictionsTrend(30)]]),
  ...variants('getContradictionCacheEntry', [['default', (e) => e.getContradictionCacheEntry({ chunk_a_hash: 'a', chunk_b_hash: 'b', model_id: 'm', prompt_version: 'v1', truncation_policy: 't' })]]),
  ...variants('putContradictionCacheEntry', [['default', (e) => e.putContradictionCacheEntry({ chunk_a_hash: 'a', chunk_b_hash: 'b', model_id: 'm', prompt_version: 'v1', truncation_policy: 't', verdict: { contradicts: false } })]]),
  ...variants('sweepContradictionCache', [['default', (e) => e.sweepContradictionCache()]]),
  ...variants('listTakes', [
    ['default', (e) => e.listTakes()],
    ['sourceId', (e) => e.listTakes({ sourceId: SRC })],
    ['sourceIds+excludePrivate', (e) => e.listTakes({ sourceIds: SRCS, excludePrivate: true, holder: 'alice-example', resolved: false, sortBy: 'weight' })],
  ]),
  ...variants('searchTakes', [
    ['default', (e) => e.searchTakes('acme')],
    ['sourceId', (e) => e.searchTakes('acme', { sourceId: SRC })],
    ['sourceIds+excludePrivate', (e) => e.searchTakes('acme', { sourceIds: SRCS, excludePrivate: true, takesHoldersAllowList: ['alice-example'] })],
  ]),
  ...variants('searchTakesVector', [
    ['default', (e) => e.searchTakesVector(EMB)],
    ['sourceId', (e) => e.searchTakesVector(EMB, { sourceId: SRC })],
    ['sourceIds+excludePrivate', (e) => e.searchTakesVector(EMB, { sourceIds: SRCS, excludePrivate: true })],
  ]),
  ...variants('getTakeEmbeddings', [['default', (e) => e.getTakeEmbeddings([1, 2])]]),
  ...variants('countStaleTakes', [['default', (e) => e.countStaleTakes()]]),
  ...variants('listStaleTakes', [['default', (e) => e.listStaleTakes()]]),
  ...variants('updateTakeEmbeddings', [['default', (e) => e.updateTakeEmbeddings([{ take_id: 1, embedding: EMB, claim: 'x', model: 'openai:text-embedding-3-large' }])]]),
  ...variants('updateTake', [
    ['default', (e) => e.updateTake(1, 1, { since_date: '2026-01-01' }), [[/UPDATE takes/, [{ id: 1 }]]]],
    ['weight', (e) => e.updateTake(1, 1, { weight: 0.8 }), [[/UPDATE takes/, [{ id: 1 }]]]],
  ]),
  ...variants('supersedeTake', [
    ['default', (e) => e.supersedeTake(1, 1, { claim: 'Acme Example will grow fast', kind: 'bet', holder: 'alice-example' }), [[/FROM takes/, [{ page_id: 1, row_num: 1, resolved_at: null, max_row: 1, next_row: 2 }]]]],
  ]),
  ...variants('resolveTake', [
    ['default', (e) => e.resolveTake(1, 1, { quality: 'correct', resolvedBy: 'alice-example' }), [[/FROM takes/, [{ page_id: 1, row_num: 1, resolved_at: null, kind: 'bet' }]]]],
  ]),
  ...variants('getScorecard', [
    ['default', (e) => e.getScorecard({}, undefined), [[/AS total_bets/, [{ total_bets: 0, resolved: 0, correct: 0, incorrect: 0, partial: 0, unresolvable_count: 0, brier: null }]]]],
    ['allFilters', (e) => e.getScorecard({ holder: 'alice-example', domainPrefix: 'companies/', since: '2026-01-01', until: '2026-06-01', sourceIds: SRCS, excludePrivate: true }, ['alice-example']), [[/AS total_bets/, [{ total_bets: 0, resolved: 0, correct: 0, incorrect: 0, partial: 0, unresolvable_count: 0, brier: null }]]]],
    ['sourceId', (e) => e.getScorecard({ sourceId: SRC }, undefined), [[/AS total_bets/, [{ total_bets: 0, resolved: 0, correct: 0, incorrect: 0, partial: 0, unresolvable_count: 0, brier: null }]]]],
  ]),
  ...variants('getCalibrationCurve', [
    ['default', (e) => e.getCalibrationCurve({}, undefined)],
    ['allFilters', (e) => e.getCalibrationCurve({ holder: 'alice-example', bucketSize: 0.2, sourceIds: SRCS, excludePrivate: true }, ['alice-example'])],
    ['sourceId', (e) => e.getCalibrationCurve({ sourceId: SRC }, undefined)],
  ]),
  ...variants('addSynthesisEvidence', [['default', (e) => e.addSynthesisEvidence([{ synthesis_page_id: 1, take_page_id: 2, take_row_num: 1, citation_index: 0 }])]]),

  // ── salience ──
  ...variants('batchLoadEmotionalInputs', [
    ['default', (e) => e.batchLoadEmotionalInputs()],
    ['slugs', (e) => e.batchLoadEmotionalInputs([SLUG])],
  ]),
  ...variants('setEmotionalWeightBatch', [
    ['default', (e) => e.setEmotionalWeightBatch([{ slug: SLUG, source_id: SRC, weight: 0.4 }])],
    ['empty', (e) => e.setEmotionalWeightBatch([])],
  ]),
  ...variants('getRecentSalience', [
    ['default', (e) => e.getRecentSalience({})],
    ['slugPrefix+sourceId+recency', (e) => e.getRecentSalience({ slugPrefix: 'people/', sourceId: SRC, recency_bias: 'on', takesHoldersAllowList: ['alice-example'], excludePrivate: true })],
    ['sourceIds', (e) => e.getRecentSalience({ sourceIds: SRCS })],
  ]),
  ...variants('listEnrichCandidates', [
    ['default', (e) => e.listEnrichCandidates({ types: ['person'], thinThreshold: 200, order: 'inbound-links' })],
    ['sourceIds+reenrich', (e) => e.listEnrichCandidates({ types: ['person'], thinThreshold: 200, order: 'inbound-links', sourceIds: SRCS, reenrichAfterMs: 86400000 })],
    ['sourceId', (e) => e.listEnrichCandidates({ types: ['person'], thinThreshold: 200, order: 'inbound-links', sourceId: SRC })],
  ]),
  ...variants('findAnomalies', [
    ['default', (e) => e.findAnomalies({ since: '2026-01-02' })],
    ['sourceId', (e) => e.findAnomalies({ since: '2026-01-02', sourceId: SRC, excludePrivate: true })],
    ['sourceIds', (e) => e.findAnomalies({ since: '2026-01-02', sourceIds: SRCS })],
  ]),

  // ── code-edges ──
  ...variants('addCodeEdges', [
    ['resolved+unresolved', (e) => e.addCodeEdges([
      { from_chunk_id: 1, to_chunk_id: 2, from_symbol_qualified: 'A.f', to_symbol_qualified: 'B.g', edge_type: 'calls' },
      { from_chunk_id: 1, from_symbol_qualified: 'A.f', to_symbol_qualified: 'C.h', edge_type: 'calls', source_id: SRC },
    ])],
  ]),
  ...variants('deleteCodeEdgesForChunks', [['default', (e) => e.deleteCodeEdgesForChunks([1, 2])]]),
  ...variants('getCallersOf', [
    ['default', (e) => e.getCallersOf('B.g')],
    ['sourceId', (e) => e.getCallersOf('B.g', { sourceId: SRC })],
  ]),
  ...variants('getCalleesOf', [
    ['default', (e) => e.getCalleesOf('A.f')],
    ['sourceId', (e) => e.getCalleesOf('A.f', { sourceId: SRC })],
    ['bareFallback', (e) => e.getCalleesOf('f', { bareFallback: true })],
  ]),
  ...variants('getEdgesByChunk', [
    ['default', (e) => e.getEdgesByChunk(1)],
    ['in+edgeType', (e) => e.getEdgesByChunk(1, { direction: 'in', edgeType: 'calls' })],
    ['out', (e) => e.getEdgesByChunk(1, { direction: 'out' })],
  ]),

  // ── cjk-search (CJK branch only) ──
  ...variants('searchKeyword', [
    ['cjk', (e) => e.searchKeyword('東京 会議')],
    ['cjk+sourceIds+detailLow', (e) => e.searchKeyword('東京 会議', { sourceIds: SRCS, detail: 'low', type: 'person' })],
  ]),
  ...variants('searchKeywordChunks', [
    ['cjk', (e) => e.searchKeywordChunks('東京 会議')],
    ['cjk+sourceId', (e) => e.searchKeywordChunks('東京 会議', { sourceId: SRC })],
  ]),
];

/**
 * Read-path cases outside the 12 W1 domains. Not part of the SQL-text golden;
 * the RLS scope inventory (EO4) observes them so every Postgres read method's
 * scoping is pinned, including the search paths that open transactions.
 */
export const EXTRA_READ_CASES: SqlCase[] = [
  ...variants('searchKeyword', [
    ['fts', (e) => e.searchKeyword('alice example')],
    ['fts+sourceIds', (e) => e.searchKeyword('alice example', { sourceIds: SRCS })],
    ['fts+orFallback', (e) => e.searchKeyword('alice example', { orFallback: true })],
  ]),
  ...variants('searchKeywordChunks', [['fts', (e) => e.searchKeywordChunks('alice example')]]),
  ...variants('searchTitles', [['default', (e) => e.searchTitles('alice example', { sourceId: SRC })]]),
  ...variants('searchVector', [['default', (e) => e.searchVector(EMB, { sourceId: SRC }), [[/AS eligible/, [{ eligible: 0 }]]]]]),
  ...variants('getStats', [['default', (e) => e.getStats(), [[/as page_count/, [{ page_count: 0, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0 }]]]]]),
  ...variants('getHealth', [['default', (e) => e.getHealth(), [[/chunk_totals AS/, [{ page_count: 0, embed_coverage: 1, dead_links: 0, missing_embeddings: 0, link_count: 0, entity_page_count: 0, link_coverage: 0, timeline_coverage: 0 }]]]]]),
  ...variants('getRawData', [['default', (e) => e.getRawData(SLUG)]]),
  ...variants('getIngestLog', [['default', (e) => e.getIngestLog()]]),
  ...variants('getConfig', [['default', (e) => e.getConfig('embedding_model')]]),
];
