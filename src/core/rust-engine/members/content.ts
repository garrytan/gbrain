/** The config, page version, page body, tag, chunk, embedding, search, link, timeline and graph members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const CONTENT_MEMBERS = {
  readSegmentedEmbedPage: 'page_body',
  readPageEmbeddingBudget: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  recordPageEmbeddingHold: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  openPageEmbeddingHold: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  reservePageEmbedding: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  settlePageEmbeddingReservation: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  readEmbeddingCompletion: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  lockEffectClaimRow: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  lockEmbeddingSwitch: 'pages', // held: no Rust store member yet; served later as 'embeddings'
  installChunkEmbeddings: 'pages', // held: no Rust store member yet; served later as 'embeddings'
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
