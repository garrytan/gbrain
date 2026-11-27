/** The config, page version, page body, tag, chunk, embedding, search, link, timeline and graph members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const CONTENT_MEMBERS = {
  readStoredConfigValue: 'pages', // held: no Rust store member yet; served later as 'config'
  readSegmentedEmbedPage: 'page_body',
  deleteRewrittenSegmentDerivations: 'page_body',
  hasUnsealedPages: 'chunks',
  readPageEmbeddingBudget: 'embeddings',
  recordPageEmbeddingHold: 'embeddings',
  openPageEmbeddingHold: 'embeddings',
  reservePageEmbedding: 'embeddings',
  settlePageEmbeddingReservation: 'embeddings',
  readEmbeddingCompletion: 'embeddings',
  lockEffectClaimRow: 'embeddings',
  lockEmbeddingSwitch: 'embeddings',
  installChunkEmbeddings: 'embeddings',
  readLinkContextMatches: 'links',
  readLinkContextOriginPages: 'links',
  // reindex-search-vector's steps (engine-sql/search-vector.ts): no-ops under the store's one language
  countSearchVectorRows: 'pages', // held: no Rust store member yet; served later as 'keyword_search'
  readRowTrustRows: 'timeline',
  listStoredTimelineRowsOrdered: 'timeline',
  deleteTimelineRows: 'timeline',
  hasSegmentStorage: 'page_body',
  listLinkEndpointPages: 'links',
  insertCanonicalTimelineRows: 'timeline',
  applyLinkTemporalRows: 'links',
  writeManualLinkTransitions: 'links',
  removeManualLinkTransitions: 'links',
  readLinkRelationshipEvidence: 'links',
  writeLinkRelationshipState: 'links',
  linkRelationshipKeysForOrigin: 'links',
  linkRelationshipKeysForPages: 'links',
  staleLinkRelationshipKeys: 'links',
  readLatestVersionIdAtTier: 'page_versions',
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
