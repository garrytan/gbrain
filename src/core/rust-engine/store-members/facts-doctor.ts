/**
 * Group 5 facts members, doctor checks (src/core/engine-sql/facts-doctor.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/doctor.rs and facts/relink.rs). `listUnpreviewedTrustFacts` is served by
 * facts-trust-reads.ts; every other member of the domain is exported here.
 *
 * The three unlinked-fact reads serve both forms: `hasAttempts: true` reads the tried, paid and no-subject memos from the
 * store's `fact_relink_attempts` rows, and `hasAttempts: false` makes every memo false. Each passes `REARMED_REASONS`, the
 * reasons a newer page re-arms, so the store's tried memo reads the same list as `conversationTriedSql`. A number that PGLite
 * binds as `LIMIT` or `int` and the store cannot read the same way (a fraction, a negative limit, a width past int4)
 * refuses rather than guess at PGLite's cast error.
 *
 * The three doctor page reads (countSegmentedCensusPages, listFactsPageBodies, readFactTableCatalog) are served by
 * facts/doctor_pages.rs.
 */
import type { BrainEngine } from '../../engine.ts';
import { REARMED_REASONS } from '../../facts/conversation-memo.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** A `LIMIT` the store reads: a non-negative integer. */
function requireCount(member: string, what: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) refuseMember(member, `${what} that is not a non-negative integer`);
}

export const listConversationFactRows: Member<'listConversationFactRows'> = (brain, sourceIds, limit) => {
  requireCount('listConversationFactRows', 'a limit', limit);
  return storeCall({ member: 'listConversationFactRows' }, () => brain.listConversationFactRows({ sourceIds, limit }));
};

export const countRedactedFacts: Member<'countRedactedFacts'> = (brain, sourceIds) =>
  storeCall({ member: 'countRedactedFacts' }, () => brain.countRedactedFacts({ sourceIds: sourceIds ?? null }));

export const listOutsideContentFenceCounts: Member<'listOutsideContentFenceCounts'> = (brain) =>
  storeCall({ member: 'listOutsideContentFenceCounts' }, () => brain.listOutsideContentFenceCounts());

export const countAtomFacts: Member<'countAtomFacts'> = (brain) =>
  storeCall({ member: 'countAtomFacts' }, () => brain.countAtomFacts());

export const countUnlinkedFactsByOrigin: Member<'countUnlinkedFactsByOrigin'> = (brain, opts) => {
  requireCount('countUnlinkedFactsByOrigin', 'a window', opts.windowPerSource);
  return storeCall({ member: 'countUnlinkedFactsByOrigin' }, () =>
    brain.countUnlinkedFactsByOrigin({ ...opts, rearmedReasons: REARMED_REASONS }));
};

export const countUnlinkedFactStats: Member<'countUnlinkedFactStats'> = (brain, opts) =>
  storeCall({ member: 'countUnlinkedFactStats' }, () => brain.countUnlinkedFactStats({ ...opts, rearmedReasons: REARMED_REASONS }));

export const countFactRelinkOutcomes: Member<'countFactRelinkOutcomes'> = (brain, sourceIds) =>
  storeCall({ member: 'countFactRelinkOutcomes' }, () => brain.countFactRelinkOutcomes(sourceIds));

export const listUnlinkedConversationSlugs: Member<'listUnlinkedConversationSlugs'> = (brain, opts) => {
  requireCount('listUnlinkedConversationSlugs', 'a window', opts.windowPerSource);
  return storeCall({ member: 'listUnlinkedConversationSlugs' }, () =>
    brain.listUnlinkedConversationSlugs({ ...opts, rearmedReasons: REARMED_REASONS }));
};

export const countFactEmbeddingCoverage: Member<'countFactEmbeddingCoverage'> = (brain, opts) => {
  if (!Number.isInteger(opts.dims) || Math.abs(opts.dims) > 2 ** 31 - 1) refuseMember('countFactEmbeddingCoverage', 'a width that is not a 32-bit integer');
  return storeCall({ member: 'countFactEmbeddingCoverage' }, () =>
    brain.countFactEmbeddingCoverage({ sourceId: opts.sourceId ?? null, model: opts.model, dims: opts.dims }));
};

export const countSegmentedCensusPages: Member<'countSegmentedCensusPages'> = (brain, sourceIds, checkedOutSourceIds) =>
  storeCall({ member: 'countSegmentedCensusPages' }, () => brain.countSegmentedCensusPages({ sourceIds, checkedOutSourceIds }));

export const readFactTableCatalog: Member<'readFactTableCatalog'> = (brain) =>
  storeCall({ member: 'readFactTableCatalog' }, () => brain.readFactTableCatalog());
