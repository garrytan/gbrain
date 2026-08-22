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
 *   - MANUAL-ONLY. Rows come exclusively from the entity_identity_link op.
 *     No auto-matching, no name-similarity heuristics — a wrong identity
 *     merge silently corrupts retrieval, so v1 keeps a human in the loop.
 *   - A page belongs to at most one identity (UNIQUE (source_id, page_id));
 *     re-linking MOVES it.
 *   - Retrieval union is OFF by default, gated by the
 *     `entity_identity.union` config key. When on, the get_links /
 *     get_backlinks ops merge edges from a page's identity co-members
 *     (dedup'd), never widening past the caller's source grant.
 *
 * Everything here goes through `engine.executeRaw` with the SAME SQL text on
 * both engines — parity by construction (pinned in the entity-identity test
 * + the DATABASE_URL-gated engine-parity suite).
 */

import type { BrainEngine } from './engine.ts';
import type { Link } from './types.ts';
import { isUndefinedTableError } from './utils.ts';

/** Config key for the flag-gated retrieval union. Default OFF. */
export const ENTITY_IDENTITY_UNION_CONFIG_KEY = 'entity_identity.union';

/**
 * Opaque identity handle grammar. Slug-flavored so handles read well in CLI
 * output and can't smuggle whitespace/quotes into messages.
 */
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

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

async function resolvePageId(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
    [slug, sourceId],
  );
  if (rows.length === 0) {
    throw new Error(`page not found: ${slug} (source ${sourceId}) — the identity key is (source_id, slug)`);
  }
  return Number(rows[0]!.id);
}

/**
 * Link a page into an identity group (upsert on the page: re-linking MOVES
 * the page to the new identity — explicit manual intent). `canonical: true`
 * demotes the group's previous canonical member first; the partial unique
 * index is the backstop against a race leaving two canonicals.
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
  const canonical = opts.canonical === true;
  const pageId = await resolvePageId(engine, opts.slug, opts.sourceId);

  if (canonical) {
    await engine.executeRaw(
      `UPDATE entity_identities SET canonical = false WHERE entity_id = $1 AND canonical`,
      [entityId],
    );
  }
  await engine.executeRaw(
    `INSERT INTO entity_identities (entity_id, source_id, page_id, confidence, established_by, canonical)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_id, page_id) DO UPDATE SET
       entity_id = EXCLUDED.entity_id,
       confidence = EXCLUDED.confidence,
       established_by = EXCLUDED.established_by,
       canonical = EXCLUDED.canonical,
       established_at = now()`,
    [entityId, opts.sourceId, pageId, confidence, establishedBy, canonical],
  );

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
  const rows = await engine.executeRaw<{ id: number }>(
    `DELETE FROM entity_identities ei
     USING pages p
     WHERE ei.page_id = p.id
       AND ei.entity_id = $1
       AND p.slug = $2
       AND ei.source_id = $3
     RETURNING ei.id`,
    [entityId, opts.slug, opts.sourceId],
  );
  return rows.length > 0;
}

/**
 * List identity members. Filters compose (AND). `allowedSources` restricts
 * MEMBER VISIBILITY (federated read grant) — a caller who can't read source
 * X never learns X's member pages, even when another member matched.
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
  opts: { entityId?: string; slug?: string; slugSourceId?: string; allowedSources?: string[] } = {},
): Promise<EntityIdentityMember[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.entityId) {
    params.push(validateEntityId(opts.entityId));
    where.push(`ei.entity_id = $${params.length}`);
  }
  if (opts.slug) {
    params.push(opts.slug);
    const slugParam = params.length;
    // #4224 review fix: the seed sub-select must be source-scoped — an
    // unscoped `p2.slug = $` matches ANY source's page with that slug, so a
    // read against a NON-member page unioned a foreign same-slug member's
    // group.
    let seedScope = '';
    if (opts.slugSourceId) {
      params.push(opts.slugSourceId);
      seedScope = ` AND ei2.source_id = $${params.length}`;
    } else if (opts.allowedSources && opts.allowedSources.length > 0) {
      const ph = opts.allowedSources.map((s) => {
        params.push(s);
        return `$${params.length}`;
      });
      seedScope = ` AND ei2.source_id IN (${ph.join(', ')})`;
    }
    where.push(`ei.entity_id IN (
      SELECT ei2.entity_id FROM entity_identities ei2
      JOIN pages p2 ON p2.id = ei2.page_id
      WHERE p2.slug = $${slugParam} AND p2.deleted_at IS NULL${seedScope}
    )`);
  }
  if (opts.allowedSources && opts.allowedSources.length > 0) {
    const placeholders = opts.allowedSources.map((s) => {
      params.push(s);
      return `$${params.length}`;
    });
    where.push(`ei.source_id IN (${placeholders.join(', ')})`);
  }
  try {
    const rows = await engine.executeRaw<{
      entity_id: string;
      source_id: string;
      slug: string;
      title: string | null;
      confidence: number;
      established_by: string;
      established_at: Date | string;
      canonical: boolean;
    }>(
      `SELECT ei.entity_id, ei.source_id, p.slug, p.title, ei.confidence,
              ei.established_by, ei.established_at, ei.canonical
       FROM entity_identities ei
       JOIN pages p ON p.id = ei.page_id AND p.deleted_at IS NULL
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ei.entity_id, ei.canonical DESC, ei.source_id, p.slug`,
      params,
    );
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
    if (isUndefinedTableError(e)) return [];
    throw e;
  }
}

/** Is the flag-gated retrieval union on? Fail-closed on any read error. */
export async function isIdentityUnionEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    const v = await engine.getConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY);
    if (v === null || v === undefined) return false;
    const s = String(v).trim().toLowerCase();
    return s === 'true' || s === '1';
  } catch {
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
  opts: { sourceId?: string; allowedSources?: string[] } = {},
): Promise<Link[]> {
  if (!(await isIdentityUnionEnabled(engine))) return links;
  let members: EntityIdentityMember[];
  try {
    members = await listEntityIdentities(engine, {
      slug,
      // #4224 review fix: seed group resolution from the BASE page's
      // (slug, source) — never from a foreign same-slug page.
      slugSourceId: opts.sourceId,
      allowedSources: opts.allowedSources,
    });
  } catch {
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
      const memberLinks = direction === 'out'
        ? await engine.getLinks(m.slug, { sourceId: m.source_id })
        : await engine.getBacklinks(m.slug, { sourceId: m.source_id });
      for (const l of memberLinks) {
        const k = keyOf(l);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(l);
      }
    } catch {
      // A single member's failure never breaks the base read.
    }
  }
  return merged;
}
