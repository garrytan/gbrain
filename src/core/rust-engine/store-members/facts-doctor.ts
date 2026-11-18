/**
 * Group 5 facts members, doctor checks (src/core/engine-sql/facts-doctor.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/doctor.rs). `listUnpreviewedTrustFacts` is served by facts-trust-reads.ts. A
 * member not exported here refuses with `engine_capability_missing`: `countFactRelinkOutcomes` (no
 * `fact_relink_attempts` table).
 *
 * The three unlinked-fact reads are served for a brain with no attempts table (`hasAttempts: false`, where the tried and
 * paid memos are false) and refuse `hasAttempts: true`, whose memos read `fact_relink_attempts`. A number that PGLite
 * binds as `LIMIT` or `int` and the store cannot read the same way (a fraction, a negative limit, a width past int4)
 * refuses rather than guess at PGLite's cast error.
 */
import type { BrainEngine } from '../../engine.ts';
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
  if (opts.hasAttempts) refuseMember('countUnlinkedFactsByOrigin', 'the fact_relink_attempts table');
  requireCount('countUnlinkedFactsByOrigin', 'a window', opts.windowPerSource);
  return storeCall({ member: 'countUnlinkedFactsByOrigin' }, () => brain.countUnlinkedFactsByOrigin(opts));
};

export const countUnlinkedFactStats: Member<'countUnlinkedFactStats'> = (brain, opts) => {
  if (opts.hasAttempts) refuseMember('countUnlinkedFactStats', 'the fact_relink_attempts table');
  return storeCall({ member: 'countUnlinkedFactStats' }, () => brain.countUnlinkedFactStats(opts));
};

export const listUnlinkedConversationSlugs: Member<'listUnlinkedConversationSlugs'> = (brain, opts) => {
  if (opts.hasAttempts) refuseMember('listUnlinkedConversationSlugs', 'the fact_relink_attempts table');
  requireCount('listUnlinkedConversationSlugs', 'a window', opts.windowPerSource);
  return storeCall({ member: 'listUnlinkedConversationSlugs' }, () => brain.listUnlinkedConversationSlugs(opts));
};

export const countFactEmbeddingCoverage: Member<'countFactEmbeddingCoverage'> = (brain, opts) => {
  if (!Number.isInteger(opts.dims) || Math.abs(opts.dims) > 2 ** 31 - 1) refuseMember('countFactEmbeddingCoverage', 'a width that is not a 32-bit integer');
  return storeCall({ member: 'countFactEmbeddingCoverage' }, () =>
    brain.countFactEmbeddingCoverage({ sourceId: opts.sourceId ?? null, model: opts.model, dims: opts.dims }));
};
