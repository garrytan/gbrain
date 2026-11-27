/** The config, page version, page body, tag, chunk, embedding, search, link, timeline and graph members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const CONTENT_MEMBERS = {
  readStoredConfigValue: 'pages', // held: no Rust store member yet; served later as 'config'
  readSegmentedEmbedPage: 'page_body',
  deleteRewrittenSegmentDerivations: 'page_body',
  hasUnsealedPages: 'chunks',
  readPageEmbeddingBudget: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  recordPageEmbeddingHold: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  openPageEmbeddingHold: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  reservePageEmbedding: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  settlePageEmbeddingReservation: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  readEmbeddingCompletion: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  lockEffectClaimRow: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  lockEmbeddingSwitch: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  installChunkEmbeddings: 'pages', // held: no Rust store member yet; served later as 'embeddings'
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
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
