/**
 * The derived-row trust writes (src/core/engine-sql/derivation-trust.ts) on a Rust brain
 * (rust/crates/gbrain-store/src/trust/derivation.rs): the tier lowering, the taint counts and the frontmatter stamps
 * read and write the page, take, timeline and fact records.
 *
 * `lowerTrustTier` lowers facts, takes, timeline rows and pages, as the SQL engines do. The propagation members
 * (`lowerDerivedDependents`, `readTierProjectionPage`, `queuePageProjection`, `locateRetierSubjects`) read the
 * `derivation_inputs` edges and the projection queue of the store; `latestRetierEventKey` answers null, as the store
 * records no belief events.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** Lowers the rows of `table` among `ids` whose stored tier ranks above `tier`; resolves the ids lowered. */
export const lowerTrustTier: Member<'lowerTrustTier'> = async (brain, table, ids, tier, origin) => {
  if (!ids.length) return [];
  return storeCall({ member: 'lowerTrustTier' }, () => brain.lowerTrustTier({ table, ids: [...ids], tier, origin: origin ?? null }));
};

/** How many take, timeline or page rows carry `taint_inputs`, and how many of those are external_untrusted. */
export const countDerivedRowTaint: Member<'countDerivedRowTaint'> = async (brain, table) =>
  storeCall({ member: 'countDerivedRowTaint' }, () => brain.countDerivedRowTaint({ table }));

/** One fixed frontmatter stamp on named pages of one source. */
export const stampPageFrontmatter: Member<'stampPageFrontmatter'> = async (brain, stamp) => {
  if (stamp.match !== 'retired' && stamp.match !== 'atom_source_hash') {
    throw new Error(`stampPageFrontmatter: unknown match ${JSON.stringify((stamp as { match: unknown }).match)}`);
  }
  if (!stamp.slugs.length) return;
  await storeCall({ member: 'stampPageFrontmatter', sourceId: stamp.sourceId }, () => brain.stampPageFrontmatter(
    stamp.match === 'retired'
      ? { match: 'retired', sourceId: stamp.sourceId, slugs: [...stamp.slugs], entries: { retired_by: stamp.retiredBy, retired_at: stamp.retiredAt } }
      : { match: 'atom_source_hash', sourceId: stamp.sourceId, slugs: [...stamp.slugs], entries: { source_hash: stamp.sourceHash } }));
};

/** One hop of the derived-tier propagation; a Rust brain is never managed, so no row is marked instead of lowered. */
export const lowerDerivedDependents: Member<'lowerDerivedDependents'> = async (brain, table, ids, managed) => {
  if (!ids.length) return [];
  return storeCall({ member: 'lowerDerivedDependents' }, () => brain.lowerDerivedDependents({ table, ids: [...ids], managed }));
};

/** The page whose chunks render the fact, take or page `id`, or null. */
export const readTierProjectionPage: Member<'readTierProjectionPage'> = async (brain, table, id) =>
  storeCall({ member: 'readTierProjectionPage' }, () => brain.readTierProjectionPage({ table, id }));

/** Queues the live page's latest revision for a projection rebuild with `reason`. */
export const queuePageProjection: Member<'queuePageProjection'> = async (brain, sourceId, slug, reason) => {
  await storeCall({ member: 'queuePageProjection', sourceId, slug }, () => brain.queuePageProjection({ sourceId, slug, reason }));
};

/** Where each listed fact, take and page lives. */
export const locateRetierSubjects: Member<'locateRetierSubjects'> = async (brain, ids) => {
  if (!ids.facts.length && !ids.takes.length && !ids.pages.length) return [];
  return storeCall({ member: 'locateRetierSubjects' }, () =>
    brain.locateRetierSubjects({ facts: [...ids.facts], takes: [...ids.takes], pages: [...ids.pages] }));
};

/**
 * The newest event that recorded a ledger subject's tier change. The store records no belief events
 * (readLedgerSource answers `coverage: null`, so retier.ts never asks for a covered subject here), so none exists.
 */
export const latestRetierEventKey: Member<'latestRetierEventKey'> = async () => null;
