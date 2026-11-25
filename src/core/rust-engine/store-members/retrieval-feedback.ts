/**
 * The retrieval feedback members (BrainEngine insertRetrievalEvents, readRetrievalEvent, applyRetrievalRatings; SQL in
 * engine-sql/retrieval-feedback.ts), served from the store's feedback records (rust/crates/gbrain-store/src/retrieval_feedback.rs,
 * rust/docs/store/retrieval-feedback.md). The retention prune, the weight reset and the weight read stay raw SQL and
 * refuse on a Rust brain.
 */
import type { AppliedRatingRow, RetrievalEventInsert, RetrievalEventRead, RetrievalRatingBatch } from '../../engine-sql/retrieval-feedback.ts';
import { storeCall, type StoreMember } from './common.ts';

export const insertRetrievalEvents: StoreMember<[events: RetrievalEventInsert[]], void> = async (brain, events) => {
  if (!events.length) return;
  await storeCall({ member: 'insertRetrievalEvents' }, () => brain.insertRetrievalEvents(events.map(e => ({
    id: e.id, client_id: e.client_id, op: e.op,
    pages: e.pages.map(p => ({ source_id: p.source_id, slug: p.slug, content_hash: p.content_hash ?? null, rank: p.rank, cited: p.cited })),
    links: e.links.map(l => ({ source_id: l.source_id, edge_key: l.edge_key, to_slug: l.to_slug })),
  }))));
};

export const readRetrievalEvent: StoreMember<[id: string], RetrievalEventRead | null> = async (brain, id) =>
  await storeCall({ member: 'readRetrievalEvent' }, () => brain.readRetrievalEvent(id)) as RetrievalEventRead | null;

export const applyRetrievalRatings: StoreMember<[args: RetrievalRatingBatch], AppliedRatingRow[]> = async (brain, args) => {
  if (!args.targets.length) return [];
  return await storeCall({ member: 'applyRetrievalRatings' }, () => brain.applyRetrievalRatings({
    eventId: args.eventId, clientId: args.clientId, signal: args.signal, alpha: args.alpha,
    targets: args.targets.map(t => ({ kind: t.kind, source_id: t.source_id, key: t.key, rating: t.rating, content_hash: t.content_hash ?? null })),
  })) as AppliedRatingRow[];
};
