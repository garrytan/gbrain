/**
 * Entity identity statements (cross-source identity groups, migration v137): the link, unlink, list and lookup SQL
 * that `src/core/entity-identity.ts` and `src/core/google/counterparty.ts` ran through `engine.executeRaw`, moved here
 * once so Postgres and PGLite share one copy. The static statements keep their text; the list builds its dynamic
 * WHERE with `sqlFragment`, so its source lists bind as `= ANY($n::text[])` (pinned by
 * test/engine-sql-caller-raw-sql-pins.test.ts). The Rust engine answers the same members from its store
 * (rust/docs/store/entity_identities.md).
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { joinFragments, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { rows } from './search-reads.ts';
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';

/** One identity link as `linkEntityIdentityRow` writes it; the caller validated every field. */
export interface EntityIdentityLinkInput {
  entityId: string;
  slug: string;
  sourceId: string;
  confidence: number;
  establishedBy: string;
  /** true makes the page the group's canonical member, false clears it, null keeps it within the same group. */
  canonical: boolean | null;
}

/** The page an unlink names, and the group it must be in. */
export interface EntityIdentityUnlinkInput {
  entityId: string;
  slug: string;
  sourceId: string;
}

/**
 * The list filters. They compose (AND). `allowedSources` restricts member visibility and the seed page; `slug` seeds
 * the groups from a live page with that slug (`slugSourceId` names its source); `excludePrivate` hides private member
 * and seed pages under the caller's page policy.
 */
export interface EntityIdentityFilter {
  entityId?: string;
  slug?: string;
  slugSourceId?: string;
  allowedSources?: readonly string[];
  excludePrivate?: boolean;
}

/** One identity member with its page (times are Dates on the SQL engines). */
export interface EntityIdentityRow {
  entity_id: string;
  source_id: string;
  slug: string;
  title: string | null;
  confidence: number;
  established_by: string;
  established_at: Date | string;
  canonical: boolean;
}

/** The group of one live member page. */
export interface EntityIdentityPageRow {
  entity_id: string;
  source_id: string;
  slug: string;
}

/** The canonical member of a page's group in another source. */
export interface CanonicalTwinRow {
  slug: string;
  source_id: string;
}

/** The page-not-found message of an identity link, the same on every engine. */
export function identityPageNotFound(slug: string, sourceId: string): Error {
  return new Error(`page not found: ${slug} (source ${sourceId}) — the identity key is (source_id, slug)`);
}

/**
 * Link a live page into a group: re-linking moves it. With `canonical: true` the group's canonical member is demoted
 * first, in the same transaction as the upsert. Throws `identityPageNotFound` with no live page.
 */
export async function linkEntityIdentityRow(exec: SqlExecutor, input: EntityIdentityLinkInput): Promise<void> {
  const found = await exec.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
    [input.slug, input.sourceId],
  );
  if (found.length === 0) throw identityPageNotFound(input.slug, input.sourceId);
  const pageId = Number(found[0]!.id);
  await exec.transaction(async (tx) => {
    if (input.canonical === true) {
      await tx.executeRaw(
        `UPDATE entity_identities SET canonical = false WHERE entity_id = $1 AND canonical`,
        [input.entityId],
      );
    }
    await tx.executeRaw(
      `INSERT INTO entity_identities (entity_id, source_id, page_id, confidence, established_by, canonical)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::boolean, false))
       ON CONFLICT (source_id, page_id) DO UPDATE SET
         entity_id = EXCLUDED.entity_id,
         confidence = EXCLUDED.confidence,
         established_by = EXCLUDED.established_by,
         canonical = CASE WHEN $6::boolean IS NULL
           THEN entity_identities.canonical AND entity_identities.entity_id = EXCLUDED.entity_id
           ELSE EXCLUDED.canonical END,
         established_at = now()`,
      [input.entityId, input.sourceId, pageId, input.confidence, input.establishedBy, input.canonical],
    );
  });
}

/** Remove a page (live or soft-deleted) from the group `entityId`. True when a row was removed. */
export async function unlinkEntityIdentityRow(exec: SqlExecutor, input: EntityIdentityUnlinkInput): Promise<boolean> {
  const removed = await exec.executeRaw<{ id: number }>(
    `DELETE FROM entity_identities ei
     USING pages p
     WHERE ei.page_id = p.id
       AND ei.entity_id = $1
       AND p.slug = $2
       AND ei.source_id = $3
     RETURNING ei.id`,
    [input.entityId, input.slug, input.sourceId],
  );
  return removed.length > 0;
}

/** The members the filter keeps, live pages only, by entity, canonical first, source, then slug. */
export async function listEntityIdentityRows(exec: LegacyUnscopedRead, filter: EntityIdentityFilter): Promise<EntityIdentityRow[]> {
  const where: SqlFragment[] = [];
  const allowed = filter.allowedSources?.length ? [...filter.allowedSources] : undefined;
  if (filter.excludePrivate) where.push(sqlFragment`${trustedSql(privatePagesFilterForCaller('p'))}`);
  if (filter.entityId) where.push(sqlFragment`ei.entity_id = ${filter.entityId}`);
  if (filter.slug) {
    const seed: SqlFragment[] = [];
    if (filter.slugSourceId) seed.push(sqlFragment` AND ei2.source_id = ${filter.slugSourceId}`);
    if (allowed) seed.push(sqlFragment` AND ei2.source_id = ANY(${allowed}::text[])`);
    if (filter.excludePrivate) seed.push(sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('p2'))}`);
    where.push(sqlFragment`ei.entity_id IN (
      SELECT ei2.entity_id FROM entity_identities ei2
      JOIN pages p2 ON p2.id = ei2.page_id AND p2.source_id = ei2.source_id
      WHERE p2.slug = ${filter.slug} AND p2.deleted_at IS NULL${joinFragments(seed, '')}
    )`);
  }
  if (allowed) where.push(sqlFragment`ei.source_id = ANY(${allowed}::text[])`);
  const clause = where.length > 0 ? sqlFragment`WHERE ${joinFragments(where, ' AND ')}` : sqlFragment``;
  const found = await rows<EntityIdentityRow>(exec, sqlFragment`SELECT ei.entity_id, ei.source_id, p.slug, p.title, ei.confidence,
              ei.established_by, ei.established_at, ei.canonical
       FROM entity_identities ei
       JOIN pages p ON p.id = ei.page_id AND p.source_id = ei.source_id AND p.deleted_at IS NULL
       ${clause}
       ORDER BY ei.entity_id COLLATE "C", ei.canonical DESC, ei.source_id COLLATE "C", p.slug COLLATE "C"`);
  return found.map(r => ({ ...r, confidence: Number(r.confidence), canonical: r.canonical === true }));
}

/**
 * The group of each live member page whose source is one of the pages' sources and whose slug is one of their slugs
 * (the cross product the SQL reads; the caller keeps only the exact pairs it asked for).
 */
export async function readEntityIdentityIdsForPages(exec: LegacyUnscopedRead, pages: ReadonlyArray<{ sourceId: string; slug: string }>): Promise<EntityIdentityPageRow[]> {
  if (pages.length === 0) return [];
  return exec.executeRaw<EntityIdentityPageRow>(
    `SELECT ei.entity_id, ei.source_id, p.slug
         FROM entity_identities ei
         JOIN pages p ON p.id = ei.page_id AND p.source_id = ei.source_id AND p.deleted_at IS NULL
        WHERE ei.source_id = ANY($1::text[]) AND p.slug = ANY($2::text[])`,
    [[...new Set(pages.map(p => p.sourceId))], [...new Set(pages.map(p => p.slug))]],
  );
}

/** The canonical members in another source of the live page's group, at most two (counterparty.ts canonicalTwin). */
export async function readCanonicalTwin(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<CanonicalTwinRow[]> {
  return exec.executeRaw<CanonicalTwinRow>(
    `SELECT c.slug, ei.source_id
         FROM entity_identities me
         JOIN pages p ON p.id = me.page_id AND p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL
         JOIN entity_identities ei ON ei.entity_id = me.entity_id AND ei.canonical AND ei.source_id <> $1
         JOIN pages c ON c.id = ei.page_id AND c.deleted_at IS NULL
        LIMIT 2`,
    [sourceId, slug],
  );
}
