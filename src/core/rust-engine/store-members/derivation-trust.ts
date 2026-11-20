/**
 * The derived-row trust writes (src/core/engine-sql/derivation-trust.ts) on a Rust brain. The derivation edges live in
 * the store's trust family (rust/crates/gbrain-store/src/trust/derivation.rs); the tier lowering, the taint counts and
 * the frontmatter stamps read and write the page records.
 *
 * `lowerTrustTier` is served for pages; on facts, takes and timeline rows it refuses with `engine_capability_missing`,
 * because no derivation the store serves lowers those yet.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** Lowers the pages of `ids` whose stored tier ranks above `tier`; resolves the ids lowered. */
export const lowerTrustTier: Member<'lowerTrustTier'> = async (brain, table, ids, tier, origin) => {
  if (table !== 'pages') refuseMember('lowerTrustTier', `a ${table} row`);
  if (!ids.length) return [];
  return storeCall({ member: 'lowerTrustTier' }, () => brain.lowerTrustTier({ ids: [...ids], tier, origin: origin ?? null }));
};

/** How many take, timeline or page rows carry `taint_inputs`, and how many of those are external_untrusted. */
export const countDerivedRowTaint: Member<'countDerivedRowTaint'> = async (brain, table) =>
  storeCall({ member: 'countDerivedRowTaint' }, () => brain.countDerivedRowTaint({ table }));

/** Records the input edges of one derived row; an edge already recorded is kept. */
export const insertDerivationInputs: Member<'insertDerivationInputs'> = async (brain, derived, inputs) => {
  if (!inputs.length) return;
  await storeCall({ member: 'insertDerivationInputs', ...(derived.sourceId ? { sourceId: derived.sourceId } : {}) },
    () => brain.insertDerivationInputs({
      derivedTable: derived.table, derivedId: derived.id, sourceId: derived.sourceId,
      inputs: inputs.map(e => ({ inputTable: e.input_table, inputId: e.input_id })),
    }));
};

/** One hop of the derived-row walk. */
export const listDerivationDependents: Member<'listDerivationDependents'> = async (brain, frontier, limit) => {
  if (!frontier.length) return [];
  return storeCall({ member: 'listDerivationDependents' }, () => brain.listDerivationDependents({
    frontier: frontier.map(e => ({ inputTable: e.input_table, inputId: e.input_id })), limit,
  }));
};

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
