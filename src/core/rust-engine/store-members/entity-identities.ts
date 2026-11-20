/**
 * Entity identity members (BrainEngine linkEntityIdentityRow, unlinkEntityIdentityRow, listEntityIdentityRows,
 * readEntityIdentityIdsForPages, readCanonicalTwin; SQL in engine-sql/entity-identities.ts). The store keeps one
 * membership per page under key tag `i` (rust/docs/store/entity_identities.md).
 *
 * Read policy: `excludePrivate` on the list applies the page policy (private-provenance.ts `storePagePolicy`), the
 * caller's reader identity and private-readable grant included; any other caller whose policy differs (folder rules,
 * lineage, an owner read) refuses. The store applies the policy's owner-only rule (owner-only flags and imessage-kind
 * sources) through the same page test readIdentitySiblingCandidates uses (privacy.rs `page_hidden`).
 */
import { identityPageNotFound, type CanonicalTwinRow, type EntityIdentityFilter, type EntityIdentityLinkInput, type EntityIdentityPageRow, type EntityIdentityRow, type EntityIdentityUnlinkInput } from '../../engine-sql/entity-identities.ts';
import { storeCall, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

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
