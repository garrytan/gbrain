/**
 * Entity identity members (BrainEngine linkEntityIdentityRow, unlinkEntityIdentityRow, listEntityIdentityRows,
 * readEntityIdentityIdsForPages, readCanonicalTwin; SQL in engine-sql/entity-identities.ts). The store keeps one
 * membership per page under key tag `i` (rust/docs/store/entity_identities.md).
 *
 * Read policy: `excludePrivate` on the list applies the page policy (private-provenance.ts `storePagePolicy`), the
 * caller's reader identity and private-readable grant included; any other caller whose policy differs (folder rules,
 * lineage, an owner read) refuses. The store does not read owner-only sources yet, so a policy read refuses while
 * the brain has one, rather than show its pages.
 *
 * Identity decisions (listEntityKeyRows, listIdentityDecisions, listRestrictedIdentityMembers, applyIdentityDecisions;
 * SQL in engine-sql/entity-keys.ts and engine-sql/identity-decisions.ts) live in gbrain-store `identity_reviews`.
 */
import { identityPageNotFound, type CanonicalTwinRow, type EntityIdentityFilter, type EntityIdentityLinkInput, type EntityIdentityPageRow, type EntityIdentityRow, type EntityIdentityUnlinkInput } from '../../engine-sql/entity-identities.ts';
import type { SourceRoutingRow } from '../../engine-sql/sources.ts';
import { isOwnerOnlySourceConfig } from '../../access/owner-only.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storeErrorCode } from '../store-errors.ts';
import type { EntityKeyRow, EntityKeyRowsOpts } from '../../engine-sql/entity-keys.ts';
import type {
  ApplyIdentityDecisionsInput, ApplyIdentityDecisionsResult, IdentityDecisionsRead, IdentityMemberRef,
} from '../../engine-sql/identity-decisions.ts';
import { privatePagesFilterFragment } from '../../search/private-visibility.ts';
import { pagePolicyFlags, storePagePolicy } from './private-provenance.ts';

/** Links the live page into the group; the identity page-not-found error with no live page. */
export const linkEntityIdentityRow: StoreMember<[input: EntityIdentityLinkInput], void> = async (brain, input) => {
  const linked = await storeCall({ member: 'linkEntityIdentityRow', slug: input.slug, sourceId: input.sourceId }, () => brain.linkEntityIdentity({
    entity_id: input.entityId, slug: input.slug, source_id: input.sourceId, confidence: input.confidence,
    established_by: input.establishedBy, canonical: input.canonical,
  }));
  if (linked !== true) throw identityPageNotFound(input.slug, input.sourceId);
};

/** Removes the page, live or soft-deleted, from the group. True when a membership was removed. */
export const unlinkEntityIdentityRow: StoreMember<[input: EntityIdentityUnlinkInput], boolean> = (brain, input) =>
  storeCall({ member: 'unlinkEntityIdentityRow', slug: input.slug, sourceId: input.sourceId },
    () => brain.unlinkEntityIdentity(input.entityId, input.slug, input.sourceId)) as Promise<boolean>;

/** The live members the filter keeps, by entity, canonical first, source, then slug (byte order). */
export const listEntityIdentityRows: StoreMember<[filter: EntityIdentityFilter], EntityIdentityRow[]> = async (brain, filter) => {
  const member = 'listEntityIdentityRows';
  const policy = storePagePolicy(member, filter.excludePrivate, { callerReaders: true });
  if (policy !== undefined) {
    const sources = (await storeCall({ member }, () => brain.listSourceRoutingRows())) as SourceRoutingRow[];
    if (sources.some((row) => isOwnerOnlySourceConfig(row.config))) refuseMember(member, 'excludePrivate while an owner-only source exists');
  }
  const found = (await storeCall({ member }, () => brain.listEntityIdentities({
    entity_id: filter.entityId || null,
    slug: filter.slug || null,
    slug_source_id: (filter.slug && filter.slugSourceId) || null,
    allowed_sources: filter.allowedSources?.length ? [...filter.allowedSources] : null,
    exclude_private: policy ?? null,
  }))) as Array<Omit<EntityIdentityRow, 'established_at'> & { established_at: string }>;
  return found.map((r) => ({ ...r, established_at: new Date(r.established_at) }));
};

/** The group of each live member of the cross product of the pages' sources and slugs, by source then slug. */
export const readEntityIdentityIdsForPages: StoreMember<[pages: ReadonlyArray<{ sourceId: string; slug: string }>], EntityIdentityPageRow[]> =
  async (brain, pages) => {
    if (pages.length === 0) return [];
    const sourceIds = [...new Set(pages.map((p) => p.sourceId))];
    const slugs = [...new Set(pages.map((p) => p.slug))];
    return storeCall({ member: 'readEntityIdentityIdsForPages' }, () => brain.readEntityIdentityIdsForPages(sourceIds, slugs)) as Promise<EntityIdentityPageRow[]>;
  };

/** The live canonical members of the page's group in another source, at most two. */
export const readCanonicalTwin: StoreMember<[sourceId: string, slug: string], CanonicalTwinRow[]> = (brain, sourceId, slug) =>
  storeCall({ member: 'readCanonicalTwin', slug, sourceId }, () => brain.readCanonicalTwin(sourceId, slug)) as Promise<CanonicalTwinRow[]>;

/**
 * Duplicate finder read. Refused: the SQL row carries the page's `generation` (the company auto-link plan pins it), and
 * the store keeps no page generation, so no row it could build would be the row the SQL engines return.
 */
export const listEntityKeyRows: StoreMember<[opts: EntityKeyRowsOpts], EntityKeyRow[]> = async () =>
  refuseMember('listEntityKeyRows', 'the store keeps no page generation');

/** The owner's identity decisions by id, the members still pending, and the revision an apply can pin. */
export const listIdentityDecisions: StoreMember<[], IdentityDecisionsRead> = (brain) =>
  storeCall({ member: 'listIdentityDecisions' }, () => brain.listIdentityDecisions());

/** The members whose page the no-caller page policy (`privatePagesFilterFragment`) hides. */
export const listRestrictedIdentityMembers: StoreMember<[members: ReadonlyArray<IdentityMemberRef>], IdentityMemberRef[]> = async (brain, members) => {
  if (!members.length) return [];
  return storeCall({ member: 'listRestrictedIdentityMembers' }, () => brain.listRestrictedIdentityMembers(
    members.map(m => ({ source_id: m.source_id, slug: m.slug })), pagePolicyFlags(privatePagesFilterFragment('p'))));
};

/**
 * Writes and removes decisions and reconciles the 'dedupe:confirm' identity rows in one store write. An `auto` input is
 * refused (its link plan pins page generations, which the store does not keep), and the store refuses (`invalid_state`)
 * while it holds a 'dedupe:auto' membership, since it has no sweep for the company links the sync made.
 */
export const applyIdentityDecisions: StoreMember<[input: ApplyIdentityDecisionsInput], ApplyIdentityDecisionsResult> = async (brain, input) => {
  const member = 'applyIdentityDecisions';
  if (input.auto) refuseMember(member, 'option auto: the store keeps no page generation');
  return storeCall({ member }, () => brain.applyIdentityDecisions({
    upsert: (input.upsert ?? []).map(d => ({
      decision_id: d.decision_id, verdict: d.verdict, members: d.members, group_id: d.group_id ?? null, entity_id: d.entity_id ?? null,
      canonical: d.canonical ? { source_id: d.canonical.source_id, slug: d.canonical.slug } : null, decided_by: d.decided_by,
      decided_at: d.decided_at ?? null, origin: d.origin, home_source_id: d.home_source_id ?? null, git_blob: d.git_blob ?? null,
      evidence: d.evidence?.length ? [...d.evidence] : null,
    })),
    remove: [...(input.remove ?? [])],
    expect_revision: input.expectRevision ?? null,
  }).catch((error: unknown) => {
    if (storeErrorCode(error) === 'invalid_state') refuseMember(member, "a 'dedupe:auto' membership the store cannot sweep");
    throw error;
  })) as Promise<ApplyIdentityDecisionsResult>;
};
