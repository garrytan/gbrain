/**
 * #4224 — cross-source entity identity (federation v1).
 *
 * THE IDENTITY KEY IS (source_id, slug). A brain can mount many sources and
 * the same real-world entity routinely exists as a different page in each
 * (`wiki:people/alice` vs `team-brain:people/alice-chen`). Nothing else in
 * gbrain asserts "these pages are the same entity" — slugs are only unique
 * per source, and titles collide freely. The `entity_identities` table
 * (migration v137) records that assertion explicitly: member pages grouped
 * under an opaque `entity_id` handle, one optional canonical member per
 * group.
 *
 * v1 posture (deliberate):
 *   - A HUMAN DECIDES. Rows come from the entity_identity_link op ('manual')
 *     and from the owner's gbrain dedupe confirm ('dedupe:confirm', the
 *     projection of a recorded decision: entities/identity-decisions.ts).
 *     No auto-matching, no name-similarity heuristics — a wrong identity
 *     merge silently corrupts retrieval, so a human stays in the loop.
 *     Near names are only flagged for review (entities/near-name.ts,
 *     extraction_pending possible_duplicates); nothing here is written from them.
 *   - A page belongs to at most one identity (UNIQUE (source_id, page_id));
 *     re-linking MOVES it.
 *   - Retrieval union is OFF by default, gated by the
 *     `entity_identity.union` config key. When on, the get_links /
 *     get_backlinks ops merge edges from a page's identity co-members
 *     (dedup'd), never widening past the caller's source grant.
 *
 * The storage goes through typed engine members (linkEntityIdentityRow,
 * unlinkEntityIdentityRow, listEntityIdentityRows, readEntityIdentityIdsForPages):
 * Postgres and PGLite share one SQL copy in engine-sql/entity-identities.ts,
 * and the Rust engine answers from its store. Validation stays here, so every
 * engine raises the same errors.
 */

import type { BrainEngine } from './engine.ts';
import type { Link } from './types.ts';
import { isMissingSchemaObject } from './utils.ts';
import { rethrowCapabilityMissing } from './rust-engine/errors.ts';

/** Config key for the flag-gated retrieval union. Default OFF. */
export const ENTITY_IDENTITY_UNION_CONFIG_KEY = 'entity_identity.union';

/**
 * Opaque identity handle grammar. Slug-flavored so handles read well in CLI
 * output and can't smuggle whitespace/quotes into messages.
 */
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

export const isEntityId = (value: string): boolean => ENTITY_ID_RE.test(value.trim());

export function validateEntityId(entityId: string): string {
  const trimmed = entityId.trim();
  if (!ENTITY_ID_RE.test(trimmed)) {
    throw new Error(
      `invalid entity_id '${entityId}': expected lowercase [a-z0-9._/-], starting alphanumeric, max 128 chars`,
    );
  }
  return trimmed;
}

export interface EntityIdentityMember {
  entity_id: string;
  source_id: string;
  slug: string;
  title: string | null;
  confidence: number;
  established_by: string;
  established_at: Date | string;
  canonical: boolean;
}

/**
 * Link a page into an identity group (upsert on the page: re-linking MOVES
 * the page to the new identity — explicit manual intent). `canonical: true`
 * demotes the group's previous canonical member first, in the same
 * transaction as the link, so a failed link never leaves the group without
 * its canonical. Omitting `canonical` keeps a re-linked member's canonical
 * flag within the same group (a confidence update must not demote it);
 * `canonical: false` demotes explicitly. The partial unique index is the
 * backstop against a race leaving two canonicals.
 */
export async function linkEntityIdentity(
  engine: BrainEngine,
  opts: {
    entityId: string;
    slug: string;
    sourceId: string;
    confidence?: number;
    establishedBy?: string;
    canonical?: boolean;
  },
): Promise<EntityIdentityMember> {
  const entityId = validateEntityId(opts.entityId);
  const confidence = opts.confidence ?? 1.0;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`confidence must be in [0,1], got ${opts.confidence}`);
  }
  const establishedBy = (opts.establishedBy ?? 'manual').trim() || 'manual';
  const canonical = typeof opts.canonical === 'boolean' ? opts.canonical : null;
  await engine.linkEntityIdentityRow({ entityId, slug: opts.slug, sourceId: opts.sourceId, confidence, establishedBy, canonical });

  const members = await listEntityIdentities(engine, { entityId });
  const me = members.find(m => m.slug === opts.slug && m.source_id === opts.sourceId);
  // The row was just written; me is only absent if a concurrent delete raced us.
  if (!me) throw new Error(`identity link for ${opts.slug} did not persist`);
  return me;
}

/** Remove a page from an identity group. Returns true when a row was removed. */
export async function unlinkEntityIdentity(
  engine: BrainEngine,
  opts: { entityId: string; slug: string; sourceId: string },
): Promise<boolean> {
  const entityId = validateEntityId(opts.entityId);
  return engine.unlinkEntityIdentityRow({ entityId, slug: opts.slug, sourceId: opts.sourceId });
}

/**
 * List identity members. Filters compose (AND). Non-empty `allowedSources` restricts
 * MEMBER VISIBILITY (federated read grant) — a caller who can't read source
 * X never learns X's member pages, even when another member matched. Without
 * that grant, `sourceId` is the scalar floor; private seeds and members are
 * excluded together when `excludePrivate` is set.
 *
 * The identity key is (source_id, slug), so the `slug` filter alone is
 * ambiguous: pass `slugSourceId` to seed group resolution from exactly the
 * (slug, source) page the caller is reading. Without it, the seed sub-select
 * is scoped to `allowedSources` when provided (a caller must not discover a
 * group through a seed page outside their grant), and only a trusted
 * unscoped caller (neither given) seeds from any source.
 */
export async function listEntityIdentities(
  engine: BrainEngine,
  opts: { entityId?: string; slug?: string; slugSourceId?: string; sourceId?: string; allowedSources?: string[]; excludePrivate?: boolean } = {},
): Promise<EntityIdentityMember[]> {
  const allowedSources = opts.allowedSources?.length ? opts.allowedSources
    : opts.sourceId ? [opts.sourceId] : undefined;
  const entityId = opts.entityId ? validateEntityId(opts.entityId) : undefined;
  try {
    const rows = await engine.listEntityIdentityRows({
      ...(entityId ? { entityId } : {}),
      ...(opts.slug ? { slug: opts.slug } : {}),
      ...(opts.slug && opts.slugSourceId ? { slugSourceId: opts.slugSourceId } : {}),
      ...(allowedSources ? { allowedSources } : {}),
      ...(opts.excludePrivate ? { excludePrivate: true } : {}),
    });
    return rows.map(r => ({
      entity_id: r.entity_id,
      source_id: r.source_id,
      slug: r.slug,
      title: r.title,
      confidence: Number(r.confidence),
      established_by: r.established_by,
      established_at: r.established_at,
      canonical: r.canonical === true,
    }));
  } catch (e) {
    // Pre-v137 brain (table missing): identity is simply "not set up yet".
    if (isMissingSchemaObject(e, 'table', 'entity_identities')) return [];
    throw e;
  }
}

/**
 * The identity group of each given (source_id, slug) page that belongs to one,
 * keyed `${source_id}:${slug}`. Pages outside any group are absent.
 */
export async function identityIdsForPages(
  engine: BrainEngine,
  pages: Array<{ sourceId: string; slug: string }>,
): Promise<Map<string, string>> {
  if (pages.length === 0) return new Map();
  const wanted = new Set(pages.map(p => `${p.sourceId}:${p.slug}`));
  try {
    const rows = await engine.readEntityIdentityIdsForPages(pages);
    return new Map(rows.map((r): [string, string] => [`${r.source_id}:${r.slug}`, r.entity_id]).filter(([k]) => wanted.has(k)));
  } catch (e) {
    if (isMissingSchemaObject(e, 'table', 'entity_identities')) return new Map();
    throw e;
  }
}

/**
 * Count once (duplicate people PR 2): the other members of the identity group a page belongs to, when that group holds a
 * member gbrain dedupe confirm or the company sweep linked; empty for a page in no group or only in a hand-made one. Trusted local callers only.
 */
export async function confirmedCoMembers(engine: BrainEngine, sourceId: string, slug: string): Promise<EntityIdentityMember[]> {
  const members = await listEntityIdentities(engine, { slug, slugSourceId: sourceId });
  if (!members.some(m => m.slug === slug && m.source_id === sourceId) || !members.some(m => m.established_by === 'dedupe:confirm' || m.established_by === 'dedupe:auto')) return [];
  return members.filter(m => !(m.slug === slug && m.source_id === sourceId));
}

/** Is the flag-gated retrieval union on? Fail-closed on any read error. */
export async function isIdentityUnionEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    const v = await engine.getConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY);
    if (v === null || v === undefined) return false;
    const s = String(v).trim().toLowerCase();
    return s === 'true' || s === '1';
  } catch (e) {
    rethrowCapabilityMissing(e);
    return false;
  }
}

/**
 * Flag-gated retrieval union for the link read ops (#4224 v1 union surface;
 * chunk-side union is a filed follow-up — member pages' chunks already
 * surface independently in search, so edges are where identity is invisible
 * today).
 *
 * Given a page slug and the links already fetched for it, fetch the same
 * direction's links for every identity CO-MEMBER the caller may see and
 * merge (dedup'd on the full edge key). Sources outside `allowedSources`
 * (when provided) are never consulted — the union must not widen a
 * federated caller's grant.
 *
 * Pure no-op when the flag is off, the table is missing, or the page is not
 * an identity member.
 */
export async function unionLinksAcrossIdentity(
  engine: BrainEngine,
  slug: string,
  links: Link[],
  direction: 'out' | 'in',
  opts: {
    sourceId?: string; allowedSources?: string[]; excludePrivate?: boolean; temporal?: import('./link-validity.ts').EdgeTemporalOpts;
    /** #6876: the caller's keyset page, applied to each member read; `onMemberRead` sees each member's rows before the merge. */
    page?: import('./link-validity.ts').LinkReadPage; onMemberRead?: (rows: Link[]) => void;
  } = {},
): Promise<Link[]> {
  if (!(await isIdentityUnionEnabled(engine))) return links;
  let members: EntityIdentityMember[];
  try {
    members = await listEntityIdentities(engine, {
      slug,
      // #4224 review fix: seed group resolution from the BASE page's
      // (slug, source) — never from a foreign same-slug page.
      slugSourceId: opts.sourceId,
      sourceId: opts.sourceId,
      allowedSources: opts.allowedSources,
      excludePrivate: opts.excludePrivate,
    });
  } catch (e) {
    rethrowCapabilityMissing(e); // a refusal is not "no identity"
    return links; // never let the union break the base read
  }
  // #4224 review fix: the identity key is (source_id, slug) — exclude only
  // the BASE pair. A same-slug co-member in ANOTHER source is a real
  // co-member whose edges the scalar-scoped base read did not fetch. When
  // the base source is unknown (trusted unscoped / federated multi-grant),
  // the base read already spanned every visible same-slug page, so
  // slug-level exclusion is exact there.
  const coMembers = opts.sourceId
    ? members.filter(m => !(m.slug === slug && m.source_id === opts.sourceId))
    : members.filter(m => m.slug !== slug);
  if (coMembers.length === 0) return links;

  const merged: Link[] = [...links];
  const keyOf = (l: Link) =>
    `${l.from_source_id}:${l.from_slug}|${l.to_source_id}:${l.to_slug}|${l.link_type}|${l.link_source ?? ''}`;
  const seen = new Set(merged.map(keyOf));
  for (const m of coMembers) {
    try {
      const memberScope = {
        sourceId: m.source_id,
        ...(opts.allowedSources?.length ? { sourceIds: opts.allowedSources } : {}),
        excludePrivate: opts.excludePrivate,
        ...(opts.temporal ? { temporal: opts.temporal } : {}),
        ...(opts.page ? { page: opts.page } : {}),
      };
      const memberLinks = direction === 'out'
        ? await engine.getLinks(m.slug, memberScope)
        : await engine.getBacklinks(m.slug, memberScope);
      opts.onMemberRead?.(memberLinks);
      for (const l of memberLinks) {
        // Federated engine reads span same-slug pages across the grant. Keep
        // this identity member's concrete pair, not a same-slug non-member.
        const memberSource = direction === 'out' ? l.from_source_id : l.to_source_id;
        if (memberSource !== m.source_id) continue;
        const k = keyOf(l);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(l);
      }
    } catch (e) {
      rethrowCapabilityMissing(e);
      // A single member's failure never breaks the base read.
    }
  }
  return merged;
}
