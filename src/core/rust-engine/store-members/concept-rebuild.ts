/**
 * The held-concept rebuild's members (BrainEngine readHeldConcept, isConceptStillHeld, lockHeldConcept,
 * lockLiveConceptMembers, listLiveConceptMemberRevisions, listConceptIncomingLinks, carryConceptIncomingLinks,
 * readTombstoneWindow, readConceptStatedKinds, readRebuildAccess, readHeldConceptRows): SQL in
 * engine-sql/concept-rebuild.ts on the SQL engines, served from rust/crates/gbrain-store/src/concept_rebuild.rs here.
 *
 * The held predicate's owed-purge op is passed from OWED_PURGE_OP, so the store and the SQL read the same checkpoint
 * op. The access read's page policy is read off the same module-load texts ACCESS_SQL splices (ACCESS_OPEN_SQL), and
 * the held-concept report's off the texts it renders at call time, so the store judges the page as the SQL does. What
 * each member answers and where it differs: rust/docs/store/concept_rebuild.md.
 */
import { OWED_PURGE_OP } from '../../persistence/derived-origin-hold.ts';
import { ACCESS_OPEN_SQL, type ConceptStatedRow, type HeldConceptRow, type RebuildAccess, type StatedKindLists } from '../../engine-sql/concept-rebuild.ts';
import { privacyAliasSql, privacyPartSql, privatePagesFilterFragment } from '../../search/private-visibility.ts';
import { storeCall, type StoreMember } from './common.ts';
import { pagePolicyFlags } from './private-provenance.ts';

export const readHeldConcept: StoreMember<[pageId: number], { deleted_us: string } | null> = async (brain, pageId) =>
  (await storeCall({ member: 'readHeldConcept' }, () => brain.readHeldConcept(pageId, OWED_PURGE_OP)) as { deleted_us: string } | null) ?? null;

export const isConceptStillHeld: StoreMember<[pageId: number, deletedUs: string], boolean> = async (brain, pageId, deletedUs) =>
  await storeCall({ member: 'isConceptStillHeld' }, () => brain.isConceptStillHeld(pageId, deletedUs, OWED_PURGE_OP)) === true;

/** The store has one writer at a time, so the SQL's `FOR UPDATE` takes no lock here. */
export const lockHeldConcept: StoreMember<[pageId: number, sourceId: string, slug: string, deletedUs: string], boolean> =
  async (brain, pageId, sourceId, slug, deletedUs) =>
    await storeCall({ member: 'lockHeldConcept', slug, sourceId }, () => brain.lockHeldConcept(pageId, sourceId, slug, deletedUs, OWED_PURGE_OP)) === true;

export const lockLiveConceptMembers: StoreMember<[sourceId: string, members: ReadonlyArray<{ slug: string; revision: string }>], number> =
  async (brain, sourceId, members) => {
    if (!members.length) return 0;
    return Number(await storeCall({ member: 'lockLiveConceptMembers', sourceId }, () =>
      brain.lockLiveConceptMembers(sourceId, members.map(m => ({ slug: m.slug, revision: m.revision })))));
  };

export const listLiveConceptMemberRevisions: StoreMember<[sourceId: string, slugs: readonly string[]], Array<{ slug: string; revision: string }>> =
  async (brain, sourceId, slugs) => {
    if (!slugs.length) return [];
    return storeCall({ member: 'listLiveConceptMemberRevisions', sourceId }, () => brain.listLiveConceptMemberRevisions(sourceId, [...slugs])) as Promise<Array<{ slug: string; revision: string }>>;
  };

export const listConceptIncomingLinks: StoreMember<[pageId: number], unknown[]> = (brain, pageId) =>
  storeCall({ member: 'listConceptIncomingLinks' }, () => brain.listConceptIncomingLinks(pageId)) as Promise<unknown[]>;

export const carryConceptIncomingLinks: StoreMember<[sourceId: string, slug: string, incoming: readonly unknown[], oldId: number], { id: number; carried: number } | null> =
  async (brain, sourceId, slug, incoming, oldId) => {
    const fresh = await storeCall({ member: 'carryConceptIncomingLinks', slug, sourceId }, () =>
      brain.carryConceptIncomingLinks(sourceId, slug, [...incoming], oldId)) as { id: number; carried: number } | null;
    return fresh ? { id: Number(fresh.id), carried: Number(fresh.carried) } : null;
  };

export const readTombstoneWindow: StoreMember<[pageId: number, hours: number], { until: string; past: boolean } | null> = async (brain, pageId, hours) =>
  (await storeCall({ member: 'readTombstoneWindow' }, () => brain.readTombstoneWindow(pageId, hours)) as { until: string; past: boolean } | null) ?? null;

export const readConceptStatedKinds: StoreMember<[pageId: number, sourceId: string, slug: string, lists: StatedKindLists], ConceptStatedRow> =
  (brain, pageId, sourceId, slug, lists) =>
    storeCall({ member: 'readConceptStatedKinds', slug, sourceId }, () => brain.readConceptStatedKinds(pageId, sourceId, slug, {
      derivedLinkSources: [...lists.derivedLinkSources], statedLabelKeys: [...lists.statedLabelKeys], synthesisKeys: [...lists.synthesisKeys],
    })) as Promise<ConceptStatedRow>;

export const readRebuildAccess: StoreMember<[pageId: number], RebuildAccess | null> = async (brain, pageId) =>
  (await storeCall({ member: 'readRebuildAccess' }, () => brain.readRebuildAccess(pageId, pagePolicyFlags(ACCESS_OPEN_SQL))) as RebuildAccess | null) ?? null;

export const readHeldConceptRows: StoreMember<[], HeldConceptRow[]> = async (brain) => {
  const privateAliases = privacyPartSql('p').includes(privacyAliasSql('p'));
  const rows = await storeCall({ member: 'readHeldConceptRows' }, () =>
    brain.readHeldConceptRows(OWED_PURGE_OP, privateAliases, pagePolicyFlags(privatePagesFilterFragment('p')))) as HeldConceptRow[];
  return rows.map(r => ({ ...r, id: Number(r.id) }));
};
