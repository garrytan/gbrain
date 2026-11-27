/**
 * Entity identity members (BrainEngine linkEntityIdentityRow, unlinkEntityIdentityRow, listEntityIdentityRows,
 * readEntityIdentityIdsForPages, readCanonicalTwin; SQL in engine-sql/entity-identities.ts). The store keeps one
 * membership per page under key tag `i` (rust/docs/store/entity_identities.md).
 *
 * Read policy: `excludePrivate` on the list applies the page policy (private-provenance.ts `storePagePolicy`), the
 * caller's reader identity and private-readable grant included; any other caller whose policy differs (folder rules,
 * lineage, an owner read) refuses. The store applies the policy's owner-only rule (owner-only flags and imessage-kind
 * sources) through the same page test readIdentitySiblingCandidates uses (privacy.rs `page_hidden`).
 *
 * Identity decisions (listEntityKeyRows, listIdentityDecisions, listRestrictedIdentityMembers, applyIdentityDecisions;
 * SQL in engine-sql/entity-keys.ts and engine-sql/identity-decisions.ts) live in gbrain-store `identity_reviews`.
 * The store keeps no decision evidence and no automatic company groups yet, and its key rows carry no page id,
 * generation, creation time or group: listEntityKeyRows refuses, listIdentityDecisions reads every decision's evidence
 * as null (none kept), and applyIdentityDecisions refuses an upsert that carries evidence or a company sweep's plan.
 */
import { identityPageNotFound, type CanonicalTwinRow, type EntityIdentityFilter, type EntityIdentityLinkInput, type EntityIdentityPageRow, type EntityIdentityRow, type EntityIdentityUnlinkInput } from '../../engine-sql/entity-identities.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import type { EntityKeyRow, EntityKeyRowsOpts } from '../../engine-sql/entity-keys.ts';
import type {
  ApplyIdentityDecisionsInput, ApplyIdentityDecisionsResult, IdentityDecisionsRead, IdentityMemberRef,
} from '../../engine-sql/identity-decisions.ts';
import { privatePagesFilterFragment } from '../../search/private-visibility.ts';
import { pagePolicyFlags, storePagePolicy } from './private-provenance.ts';

/**
 * `confidence` is DOUBLE PRECISION on the SQL engines, which keep NaN and ±Infinity and read them back as numbers.
 * JSON has no number for those three, so they cross the store boundary as the text Postgres prints for them.
 */
const toStoreFloat = (value: number): number | string => Number.isFinite(value) ? value : String(value);
const fromStoreFloat = (value: number | string): number => typeof value === 'string' ? Number(value) : value;

/** Links the live page into the group; the identity page-not-found error with no live page. */
export const linkEntityIdentityRow: StoreMember<[input: EntityIdentityLinkInput], void> = async (brain, input) => {
  const linked = await storeCall({ member: 'linkEntityIdentityRow', slug: input.slug, sourceId: input.sourceId }, () => brain.linkEntityIdentity({
    entity_id: input.entityId, slug: input.slug, source_id: input.sourceId, confidence: toStoreFloat(input.confidence),
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
  }))) as Array<Omit<EntityIdentityRow, 'established_at' | 'confidence'> & { established_at: string; confidence: number | string }>;
  return found.map((r) => ({ ...r, confidence: fromStoreFloat(r.confidence), established_at: new Date(r.established_at) }));
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
 * Duplicate finder read: live, unretired pages of the types in unarchived sources, the named keys only, keyset-paged,
 * narrowed to `members` and to pages with a `tokens` value. A row's `generation` is the page's `pages.generation`, the counter
 * the store keeps like the SQL engines' trigger (rust/docs/store/entity_identities.md).
 */
export const listEntityKeyRows: StoreMember<[opts: EntityKeyRowsOpts], EntityKeyRow[]> = (brain, opts) =>
  storeCall({ member: 'listEntityKeyRows' }, () => brain.listEntityKeyRows({
    types: [...opts.types], keys: [...opts.keys], after: opts.after ? { source_id: opts.after.source_id, slug: opts.after.slug } : null,
    limit: opts.limit,
    members: opts.members ? opts.members.map(m => ({ source_id: m.source_id, slug: m.slug })) : null,
    tokens: opts.tokens ? { values: [...opts.tokens.values], fields: [...opts.tokens.fields] } : null,
    collapsed: opts.collapsed === true,
  }));

/** The owner's identity decisions by id, the members still pending, and the revision an apply can pin. No evidence is kept. */
export const listIdentityDecisions: StoreMember<[], IdentityDecisionsRead> = async (brain) => {
  const read = await storeCall({ member: 'listIdentityDecisions' }, () => brain.listIdentityDecisions()) as IdentityDecisionsRead;
  return { ...read, decisions: read.decisions.map(d => ({ ...d, evidence: d.evidence ?? null })) };
};

/** The members whose page the no-caller page policy (`privatePagesFilterFragment`) hides. */
export const listRestrictedIdentityMembers: StoreMember<[members: ReadonlyArray<IdentityMemberRef>], IdentityMemberRef[]> = async (brain, members) => {
  if (!members.length) return [];
  return storeCall({ member: 'listRestrictedIdentityMembers' }, () => brain.listRestrictedIdentityMembers(
    members.map(m => ({ source_id: m.source_id, slug: m.slug })), pagePolicyFlags(privatePagesFilterFragment('p'))));
};

/** Writes and removes decisions and reconciles the 'dedupe:auto' and 'dedupe:confirm' identity rows in one store write. */
export const applyIdentityDecisions: StoreMember<[input: ApplyIdentityDecisionsInput], ApplyIdentityDecisionsResult> = (brain, input) =>
  storeCall({ member: 'applyIdentityDecisions' }, () => brain.applyIdentityDecisions({
    upsert: (input.upsert ?? []).map(d => ({
      decision_id: d.decision_id, verdict: d.verdict, members: d.members, group_id: d.group_id ?? null, entity_id: d.entity_id ?? null,
      canonical: d.canonical ? { source_id: d.canonical.source_id, slug: d.canonical.slug } : null, decided_by: d.decided_by,
      decided_at: d.decided_at ?? null, origin: d.origin, home_source_id: d.home_source_id ?? null, git_blob: d.git_blob ?? null,
      evidence: d.evidence?.length ? [...d.evidence] : null,
    })),
    remove: [...(input.remove ?? [])],
    expect_revision: input.expectRevision ?? null,
    auto: input.auto ? {
      link: input.auto.link.map(g => ({
        entity_id: g.entity_id, canonical_page_id: g.canonical_page_id,
        members: g.members.map(m => ({ source_id: m.source_id, page_id: m.page_id, generation: m.generation })),
      })),
      unlink: [...input.auto.unlink],
    } : null,
  }));
