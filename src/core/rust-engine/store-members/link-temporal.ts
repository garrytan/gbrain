/**
 * Link temporal state (src/core/engine-sql/link-temporal.ts): the relationship evidence and state rows, the origin's
 * tense and derived transitions, manual transitions, and the reads of relationship notes, doctor edge_validity and
 * mentions/referrers. The store keeps them under `q <source> \0 R` and `q <source> \0 T`
 * (rust/docs/store/link_temporal.md). The relationship builder stays in TypeScript (link-relationships.ts): it reads
 * the pack's relation semantics, which live in this process.
 *
 * Also here: reindex-search-vector's steps, which are no-ops under the store's one keyword language, and the
 * embedding-held count of retrieval coverage, which is zero because the store keeps no embedding budget. The pending
 * and rebuild coverage counts are not served: the store keeps no projection queue, so they refuse.
 *
 * Export only BrainEngine members from this file (index.ts spreads the module into STORE_MEMBERS); helpers stay
 * unexported.
 */
import type { CoverageRelevance, ScopedCount } from '../../search/retrieval-coverage.ts';
import type { ProjectionReadinessScope } from '../../search/projection-readiness.ts';
import type * as LinkTemporalSql from '../../engine-sql/link-temporal.ts';
import { DERIVED_TRANSITION_PRODUCERS } from '../../engine-sql/link-temporal.ts';
import type { RelationshipEvidence, RelationshipKey, RelationshipStateWrite } from '../../link-relationships.ts';
import { temporalLinkTypes } from '../../link-validity.ts';
import { privacyAliasSql, privatePagesFilterFragment, privateSnapshotFilterFragment } from '../../search/private-visibility.ts';
import type { VectorBackfillOpts } from '../../search-vector-backfill.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

type PageRef = { slug: string; source_id: string };

/** The no-caller page policy of `privatePagesFilterFragment`, which decides whether an evidence origin is public. */
function originPolicy() {
  const fragment = privatePagesFilterFragment('p');
  return { honorAliases: fragment.includes(privacyAliasSql('p')), entityPrivacy: fragment.includes(privateSnapshotFilterFragment('p')) };
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
    const excludePrivate = storePagePolicy('listRelationshipNoteRows', opts?.excludePrivate) ?? null;
    if (!subjects.length) return [];
    return storeCall({ member: 'listRelationshipNoteRows' }, () => brain.listRelationshipNoteRows({
      subjects: subjects.map(s => ({ slug: s.slug, source_id: s.source_id })), excludePrivate }));
  };

export const edgeValidityCounts: StoreMember<[opts: { sourceIds?: readonly string[]; staleLimit: number }], LinkTemporalSql.EdgeValidityCounts | null> =
  (brain, opts) => storeCall({ member: 'edgeValidityCounts' }, () => brain.edgeValidityCounts({
    sourceIds: opts.sourceIds?.length ? [...opts.sourceIds] : null, staleLimit: Math.max(0, Math.trunc(opts.staleLimit)) }));

export const listPageStatusByRef: StoreMember<[refs: ReadonlyArray<PageRef>, scope: { excludePrivate: boolean; includeQuarantined?: boolean }],
  Array<{ source_id: string; slug: string; status: unknown }>> = async (brain, refs, scope) => {
    const excludePrivate = storePagePolicy('listPageStatusByRef', scope?.excludePrivate) ?? null;
    if (!refs.length) return [];
    return storeCall({ member: 'listPageStatusByRef' }, () => brain.listPageStatusByRef({
      refs: refs.map(r => ({ slug: r.slug, source_id: r.source_id })), excludePrivate, includeQuarantined: scope?.includeQuarantined === true }));
  };

export const listRecordMetadataRows: StoreMember<[pageIds: readonly number[],
  scope: { referrerSources: readonly string[]; excludePrivate: boolean; includeQuarantined?: boolean }], LinkTemporalSql.RecordMetadataRows> =
  async (brain, pageIds, scope) => {
    const excludePrivate = storePagePolicy('listRecordMetadataRows', scope?.excludePrivate) ?? null;
    if (!pageIds.length) return { status: [], links: [] };
    return storeCall({ member: 'listRecordMetadataRows' }, () => brain.listRecordMetadataRows({
      pageIds: ids(pageIds), referrerSources: [...scope.referrerSources], excludePrivate,
      includeQuarantined: scope.includeQuarantined === true, scope: scope.excludePrivate ? 'world' : 'all' }));
  };

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
// Retrieval coverage: the store keeps no embedding budget, so no page is held.
// ---------------------------------------------------------------------------------------------------------------------

export const countEmbeddingHeldPages: StoreMember<[scope: ProjectionReadinessScope, relevance: CoverageRelevance], ScopedCount | null> =
  async (_brain: StoreBrain, _scope, relevance) => ({
    total: 0, could_affect: 0, capped: false, ...(relevance.exactTopPageId != null ? { top_counted: false } : {}),
  });
