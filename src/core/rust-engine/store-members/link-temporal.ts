/**
 * Link temporal state (src/core/engine-sql/link-temporal.ts): the relationship evidence and state rows, the origin's
 * tense and derived transitions, manual transitions, and the reads of relationship notes, doctor edge_validity and
 * mentions/referrers. The store keeps them under `q <source> \0 R` and `q <source> \0 T`
 * (rust/docs/store/link_temporal.md). The relationship builder stays in TypeScript (link-relationships.ts): it reads
 * the pack's relation semantics, which live in this process.
 *
 * Also here: reindex-search-vector's steps, which are no-ops under the store's one keyword language, and retrieval
 * coverage. The embedding-held count is zero because the store keeps no embedding budget. The pending count, the
 * rebuild progress and the readiness probe's statement read the store's pages and projection queue
 * (rust/crates/gbrain-store/src/link_queries/retrieval_coverage.rs). The probe's generation is null: the store has no
 * page clock, so the probe never caches its answer here.
 *
 * Export only BrainEngine members from this file (index.ts spreads the module into STORE_MEMBERS); helpers stay
 * unexported.
 */
import { COVERAGE_COUNT_TIMEOUT_MS, type CoverageRelevance, type ProjectionRebuildProgress, type ScopedCount } from '../../search/retrieval-coverage.ts';
import { coveragePatternWord } from './coverage-pattern.ts';
import type { ProjectionReadinessRow, ProjectionReadinessScope } from '../../search/projection-readiness.ts';
import type * as LinkTemporalSql from '../../engine-sql/link-temporal.ts';
import { DERIVED_TRANSITION_PRODUCERS } from '../../engine-sql/link-temporal.ts';
import type { RelationshipEvidence, RelationshipKey, RelationshipStateWrite } from '../../link-relationships.ts';
import { temporalLinkTypes } from '../../link-validity.ts';
import { privatePagesFilterFragment } from '../../search/private-visibility.ts';
import type { VectorBackfillOpts } from '../../search-vector-backfill.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { coverageScope } from './coverage-scope.ts';
import { pagePolicyFlags, storePagePolicy } from './private-provenance.ts';

type PageRef = { slug: string; source_id: string };

/** The no-caller page policy of `privatePagesFilterFragment`, which decides whether an evidence origin is public. */
function originPolicy() {
  return pagePolicyFlags(privatePagesFilterFragment('p'));
}

const ids = (pageIds: readonly number[]) => pageIds.map(Number);

export const readLinkRelationshipEvidence: StoreMember<[keys: readonly RelationshipKey[]], RelationshipEvidence> = (brain, keys) =>
  storeCall({ member: 'readLinkRelationshipEvidence' }, () =>
    brain.readLinkRelationshipEvidence({ keys: [...keys], originPolicy: originPolicy() }));

export const writeLinkRelationshipState: StoreMember<[write: RelationshipStateWrite], number> = (brain, write) =>
  storeCall({ member: 'writeLinkRelationshipState' }, () =>
    brain.writeLinkRelationshipState({ upserts: write.upserts, removals: write.removals, changed: write.changed }));

export const linkRelationshipKeysForPages: StoreMember<[pageIds: readonly number[]], RelationshipKey[]> = async (brain, pageIds) =>
  pageIds.length === 0 ? [] : storeCall({ member: 'linkRelationshipKeysForPages' }, () =>
    brain.linkRelationshipKeysForPages({ pageIds: ids(pageIds), linkTypes: temporalLinkTypes() }));

export const staleLinkRelationshipKeys: StoreMember<[limit: number], RelationshipKey[]> = (brain, limit) =>
  storeCall({ member: 'staleLinkRelationshipKeys' }, () =>
    brain.staleLinkRelationshipKeys({ limit: Math.max(0, Math.trunc(limit)), linkTypes: temporalLinkTypes() }));

export const linkRelationshipKeysForOrigin: StoreMember<[pageId: number], RelationshipKey[]> = (brain, pageId) =>
  storeCall({ member: 'linkRelationshipKeysForOrigin' }, () =>
    brain.linkRelationshipKeysForOrigin({ pageId: Number(pageId), linkTypes: temporalLinkTypes() }));

export const applyLinkTemporalRows: StoreMember<[input: LinkTemporalSql.LinkTemporalRows], LinkTemporalSql.LinkTemporalApplied> = (brain, input) =>
  storeCall({ member: 'applyLinkTemporalRows', sourceId: input.sourceId }, () => brain.applyLinkTemporalRows({
    pageId: Number(input.pageId), sourceId: input.sourceId, tenseRows: input.tenseRows, transitions: input.transitions,
    explicitTargets: input.explicitTargets, producers: DERIVED_TRANSITION_PRODUCERS, linkTypes: temporalLinkTypes(),
  }));

export const writeManualLinkTransitions: StoreMember<[rel: LinkTemporalSql.ManualLinkRelationship,
  rows: ReadonlyArray<{ kind: 'start' | 'end'; occurred_on: string }>], { inserted: number; key: RelationshipKey | null }> =
  (brain, rel, rows) => storeCall({ member: 'writeManualLinkTransitions', sourceId: rel.sourceId }, () =>
    brain.writeManualLinkTransitions({ rel: { from: rel.from, to: rel.to, linkType: rel.linkType, sourceId: rel.sourceId }, rows: [...rows] }));

export const removeManualLinkTransitions: StoreMember<[rel: { from: string; to: string; linkType?: string; sourceId: string; databaseOnly?: boolean }],
  RelationshipKey[]> = (brain, rel) => storeCall({ member: 'removeManualLinkTransitions', sourceId: rel.sourceId }, () =>
    brain.removeManualLinkTransitions({ from: rel.from, to: rel.to, linkType: rel.linkType ?? null, sourceId: rel.sourceId,
      databaseOnly: rel.databaseOnly === true }));

export const listRelationshipNoteRows: StoreMember<[subjects: ReadonlyArray<PageRef>, opts: { excludePrivate: boolean }],
  LinkTemporalSql.RelationshipNoteRow[]> = async (brain, subjects, opts) => {
    const excludePrivate = storePagePolicy('listRelationshipNoteRows', opts?.excludePrivate, { callerReaders: true }) ?? null;
    if (!subjects.length) return [];
    return storeCall({ member: 'listRelationshipNoteRows' }, () => brain.listRelationshipNoteRows({
      subjects: subjects.map(s => ({ slug: s.slug, source_id: s.source_id })), excludePrivate }));
  };

export const edgeValidityCounts: StoreMember<[opts: { sourceIds?: readonly string[]; staleLimit: number }], LinkTemporalSql.EdgeValidityCounts | null> =
  (brain, opts) => storeCall({ member: 'edgeValidityCounts' }, () => brain.edgeValidityCounts({
    sourceIds: opts.sourceIds?.length ? [...opts.sourceIds] : null, staleLimit: Math.max(0, Math.trunc(opts.staleLimit)) }));

export const listPageStatusByRef: StoreMember<[refs: ReadonlyArray<PageRef>, scope: { excludePrivate: boolean; includeQuarantined?: boolean }],
  Array<{ source_id: string; slug: string; status: unknown }>> = async (brain, refs, scope) => {
    const excludePrivate = storePagePolicy('listPageStatusByRef', scope?.excludePrivate, { callerReaders: true }) ?? null;
    if (!refs.length) return [];
    return storeCall({ member: 'listPageStatusByRef' }, () => brain.listPageStatusByRef({
      refs: refs.map(r => ({ slug: r.slug, source_id: r.source_id })), excludePrivate, includeQuarantined: scope?.includeQuarantined === true }));
  };

export const listRecordMetadataRows: StoreMember<[pageIds: readonly number[],
  scope: { referrerSources: readonly string[]; excludePrivate: boolean; includeQuarantined?: boolean }], LinkTemporalSql.RecordMetadataRows> =
  async (brain, pageIds, scope) => {
    const excludePrivate = storePagePolicy('listRecordMetadataRows', scope?.excludePrivate, { callerReaders: true }) ?? null;
    if (!pageIds.length) return { status: [], links: [] };
    return storeCall({ member: 'listRecordMetadataRows' }, () => brain.listRecordMetadataRows({
      pageIds: ids(pageIds), referrerSources: [...scope.referrerSources], excludePrivate,
      includeQuarantined: scope.includeQuarantined === true, scope: scope.excludePrivate ? 'world' : 'all' }));
  };

export const readReferrerGroupRows: StoreMember<[target: { sources: readonly string[]; slugs: readonly string[] },
  scope: LinkTemporalSql.ReferrerGroupScope], LinkTemporalSql.ReferrerGroupRow[]> = async (brain, target, scope) => {
    const excludePrivate = storePagePolicy('readReferrerGroupRows', scope?.excludePrivate, { callerReaders: true }) ?? null;
    return storeCall({ member: 'readReferrerGroupRows' }, () => brain.readReferrerGroupRows({
      targetSources: [...target.sources], targetSlugs: [...target.slugs], referrerSources: [...scope.referrerSources],
      storedTypes: [...scope.storedTypes], canonicalTypes: [...scope.canonicalTypes], excludePrivate,
      minTrust: scope.eligibility?.floor ?? null, suppressFlagged: scope.eligibility?.suppressFlagged === true,
      includeQuarantined: scope.includeQuarantined === true, perGroup: Math.max(0, Math.trunc(scope.perGroup)) }));
  };

export const readReferrerPageDetails: StoreMember<[ids: readonly number[]], LinkTemporalSql.ReferrerPageDetailRow[]> = async (brain, pageIds) =>
  pageIds.length === 0 ? [] : storeCall({ member: 'readReferrerPageDetails' }, () => brain.readReferrerPageDetails({ ids: ids(pageIds) }));

export const readReferrerTargetCounts: StoreMember<[target: { sources: readonly string[]; slugs: readonly string[]; indexes: readonly number[] },
  scope: LinkTemporalSql.ReferrerTargetCountScope], LinkTemporalSql.ReferrerTargetCountRow[]> = async (brain, target, scope) => {
    const excludePrivate = storePagePolicy('readReferrerTargetCounts', scope?.excludePrivate, { callerReaders: true }) ?? null;
    return storeCall({ member: 'readReferrerTargetCounts' }, () => brain.readReferrerTargetCounts({
      targetSources: [...target.sources], targetSlugs: [...target.slugs], targetIndexes: [...target.indexes],
      referrerSources: [...scope.referrerSources], storedTypes: [...scope.storedTypes], canonicalTypes: [...scope.canonicalTypes],
      recordTypes: [...scope.recordTypes], excludePrivate, minTrust: scope.eligibility?.floor ?? null,
      suppressFlagged: scope.eligibility?.suppressFlagged === true, includeQuarantined: scope.includeQuarantined === true }));
  };

export const listReferrerTargetSources: StoreMember<[slug: string, sources: readonly string[]], string[]> = async (brain, slug, sources) =>
  sources.length === 0 ? [] : storeCall({ member: 'listReferrerTargetSources' }, () => brain.listReferrerTargetSources({ slug, sources: [...sources] }));

/** The referrer page's read scope, in the store's input shape. */
function referrerRowInput(member: string, target: { sources: readonly string[]; slugs: readonly string[] }, scope: LinkTemporalSql.ReferrerTypeScope & { type?: string | null }) {
  const excludePrivate = storePagePolicy(member, scope?.excludePrivate, { callerReaders: true }) ?? null;
  return {
    targetSources: [...target.sources], targetSlugs: [...target.slugs], referrerSources: [...scope.referrerSources],
    storedTypes: [...scope.storedTypes], canonicalTypes: [...scope.canonicalTypes], excludePrivate, type: scope.type ?? null,
    minTrust: scope.eligibility?.floor ?? null, suppressFlagged: scope.eligibility?.suppressFlagged === true,
    includeQuarantined: scope.includeQuarantined === true,
  };
}

export const countReferrerRows: StoreMember<[target: { sources: readonly string[]; slugs: readonly string[] },
  scope: LinkTemporalSql.ReferrerRowScope], number> = async (brain, target, scope) => {
    const input = referrerRowInput('countReferrerRows', target, scope);
    return storeCall({ member: 'countReferrerRows' }, () => brain.countReferrerRows(input));
  };

/** The store returns each pair once, by canonical then stored type; an untyped referrer's stored type is `""`, as in SQL. */
export const readReferrerTypes: StoreMember<[target: { sources: readonly string[]; slugs: readonly string[] },
  scope: LinkTemporalSql.ReferrerTypeScope], LinkTemporalSql.ReferrerTypeRow[]> = async (brain, target, scope) => {
    const input = referrerRowInput('readReferrerTypes', target, scope);
    return storeCall({ member: 'readReferrerTypes' }, () => brain.readReferrerTypes(input));
  };

export const readReferrerRows: StoreMember<[target: { sources: readonly string[]; slugs: readonly string[] },
  scope: LinkTemporalSql.ReferrerRowScope & { cursor: readonly [string | null, string, string] | null; limit: number }], LinkTemporalSql.ReferrerRow[]> = async (brain, target, scope) => {
    const input = referrerRowInput('readReferrerRows', target, scope);
    return storeCall({ member: 'readReferrerRows' }, () => brain.readReferrerRows({ ...input,
      cursor: scope.cursor ? [...scope.cursor] : null, limit: Math.max(0, Math.trunc(scope.limit)) }));
  };

export const readReferrerRecordCandidates: StoreMember<[target: { sources: readonly string[]; slugs: readonly string[]; indexes: readonly number[] },
  scope: LinkTemporalSql.ReferrerRecordCandidateScope], LinkTemporalSql.ReferrerRecordCandidateRow[]> = async (brain, target, scope) => {
    const excludePrivate = storePagePolicy('readReferrerRecordCandidates', scope?.excludePrivate, { callerReaders: true }) ?? null;
    return storeCall({ member: 'readReferrerRecordCandidates' }, () => brain.readReferrerRecordCandidates({
      targetSources: [...target.sources], targetSlugs: [...target.slugs], targetIndexes: [...target.indexes],
      referrerSources: [...scope.referrerSources], storedTypes: [...scope.storedTypes], canonicalTypes: [...scope.canonicalTypes],
      recordTypes: [...scope.recordTypes], excludePrivate, minTrust: scope.eligibility?.floor ?? null,
      suppressFlagged: scope.eligibility?.suppressFlagged === true, includeQuarantined: scope.includeQuarantined === true,
      perTarget: Math.max(0, Math.trunc(scope.perTarget)) }));
  };

export const readReferrerRecordPages: StoreMember<[ids: readonly number[]], LinkTemporalSql.ReferrerRecordPageRow[]> = async (brain, pageIds) =>
  pageIds.length === 0 ? [] : storeCall({ member: 'readReferrerRecordPages' }, () => brain.readReferrerRecordPages({ ids: ids(pageIds) }));

// ---------------------------------------------------------------------------------------------------------------------
// reindex-search-vector: the store keeps one keyword index, built for the language PGLite's default `english` names.
// Rebuilding it for `english` changes nothing; any other language refuses rather than claiming a rebuild.
// ---------------------------------------------------------------------------------------------------------------------

const STORE_LANGUAGE = 'english';

function storeLanguage(member: string, lang: string): void {
  if (lang !== STORE_LANGUAGE) refuseMember(member, `keyword language ${lang} (the store indexes ${STORE_LANGUAGE} only)`);
}

export const countSearchVectorRows: StoreMember<[], { pages: number; chunks: number }> = brain =>
  storeCall({ member: 'countSearchVectorRows' }, () => brain.countSearchVectorRows());

export const replaceSearchVectorTriggerFunction: StoreMember<[target: 'pages' | 'chunks', lang: string], void> = async (_brain, _target, lang) => {
  storeLanguage('replaceSearchVectorTriggerFunction', lang);
};

export const backfillSearchVectors: StoreMember<[target: 'pages' | 'chunks', opts: Pick<VectorBackfillOpts, 'lang' | 'checkpoint' | 'tick'>], number> =
  async (_brain, _target, opts) => {
    storeLanguage('backfillSearchVectors', opts.lang);
    return 0;
  };

export const ensureFactsKeywordIndex: StoreMember<[lang: string, notice?: (line: string) => void], 'present' | 'swapped'> = async (_brain, lang) => {
  storeLanguage('ensureFactsKeywordIndex', lang);
  return 'present';
};

// ---------------------------------------------------------------------------------------------------------------------
// Retrieval coverage. The store keeps no embedding budget, so no page is held. The other reads send the scope with the
// store's private-page policy (a caller's reader identity and private-readable grant included), the trust floor and the
// flagged-page filter (the store reads each page's stamped tier and
// write-gate receipts), and `requireSafeChunks` changes nothing because these reads count pages, not chunks.
// ---------------------------------------------------------------------------------------------------------------------

/** The query word of one `coverageRelevance` pattern; any other pattern refuses (the store runs no POSIX regex). */
const patternWord = coveragePatternWord;

export const countPendingProjectionPages: StoreMember<[scope: ProjectionReadinessScope, relevance: CoverageRelevance], ScopedCount | null> =
  async (brain, scope, relevance) => {
    const member = 'countPendingProjectionPages';
    const input = {
      scope: coverageScope(member, scope),
      relevance: {
        all: relevance.all === true, types: [...relevance.types], terms: relevance.patterns.map(p => patternWord(member, p)),
        pageIds: ids(relevance.pageIds), exactTopPageId: relevance.exactTopPageId == null ? null : Number(relevance.exactTopPageId),
        imageArm: relevance.imageArm === true,
      },
      timeoutMs: COVERAGE_COUNT_TIMEOUT_MS,
    };
    // Each count is min(every match in scope, cap) on every engine, so a capped count is the same answer too. A walk
    // past the time limit gives null (unknown), as a SQL count that times out does.
    return storeCall({ member }, () => brain.countPendingProjectionPages(input)) as Promise<ScopedCount | null>;
  };

export const projectionRebuildProgress: StoreMember<[scope: ProjectionReadinessScope], ProjectionRebuildProgress | null> = async (brain, scope) => {
  const input = coverageScope('projectionRebuildProgress', scope);
  return storeCall({ member: 'projectionRebuildProgress' }, () => brain.projectionRebuildProgress(input));
};

/**
 * The brain and its commit sequence: every commit advances it, so the probe's cached answer lasts until the next write.
 * Null inside a transaction, whose own writes the sequence does not count yet, so the probe there is never cached.
 */
export const readProjectionReadinessGeneration: StoreMember<[], string | null> = async (brain) =>
  storeCall({ member: 'readProjectionReadinessGeneration' }, () => brain.readProjectionReadinessGeneration());

export const readProjectionReadiness: StoreMember<[scope: ProjectionReadinessScope], ProjectionReadinessRow> = async (brain, scope) => {
  const input = coverageScope('readProjectionReadiness', scope);
  return storeCall({ member: 'readProjectionReadiness' }, () => brain.readProjectionReadiness(input));
};

export const countEmbeddingHeldPages: StoreMember<[scope: ProjectionReadinessScope, relevance: CoverageRelevance], ScopedCount | null> =
  async (_brain: StoreBrain, _scope, relevance) => ({
    total: 0, could_affect: 0, capped: false, ...(relevance.exactTopPageId != null ? { top_counted: false } : {}),
  });

/** `readPageReferenceDate`: the live page's reference date as the store prints it, or null. */
export const readPageReferenceDate: StoreMember<[sourceId: string, slug: string], string | null> = async (brain, sourceId, slug) =>
  (await storeCall({ member: 'readPageReferenceDate', slug, sourceId }, () => brain.readPageReferenceDate(sourceId, slug))) ?? null;
