/**
 * The relational recall arm's page reads (search/relational-recall.ts). One SQL implementation for both engines; each
 * statement text is what the arm sent through `executeRaw`. The decisions (which seeds to resolve, what to hydrate)
 * stay in the arm.
 */
import type { PageReadPolicy } from '../types.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { buildVisibilityClause } from '../search/sql-ranking.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import { retiredPageSql } from '../entities/resolve.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** A (source_id, slug) page reference. */
export interface PageRefRow { source_id: string; slug: string }

const REFS_JOIN = `JOIN unnest($1::text[], $2::text[]) AS refs(source_id, slug)
       ON p.source_id = refs.source_id AND p.slug = refs.slug`;

/**
 * The refs that name a live, unquarantined page of an unarchived source which `policy` admits (its source scope,
 * private-page filter and trust floor; `pageReadFilter` live), in no set order. A ref listed twice answers twice.
 */
export async function readAdmittedPageRefs(exec: LegacyUnscopedRead, refs: readonly PageRefRow[], policy: PageReadPolicy): Promise<PageRefRow[]> {
  if (!refs.length) return [];
  const params: unknown[] = [refs.map(ref => ref.source_id), refs.map(ref => ref.slug)];
  const filter = pageReadFilter('p', policy, params, true);
  return exec.executeRaw<PageRefRow>(
    `SELECT p.source_id, p.slug FROM pages p
     ${REFS_JOIN} WHERE ${filter}`, params,
  );
}

const DATE_FIELDS_JOIN = 'JOIN unnest($1::text[], $2::text[]) AS w(source_id, slug) ON p.source_id = w.source_id AND p.slug = w.slug';

/** A page's observation-date inputs: its frontmatter (a JSON object or its text) and import filename. */
export interface PageDateFieldsRow { source_id: string; slug: string; frontmatter: unknown; import_filename: string | null }

/**
 * The observation-date inputs of the refs' pages that `policy` admits (its source scope, private-page filter and
 * trust floor; `pageReadFilter` live), in no set order (search/evidence-date.ts `factObservationDates`). A ref listed
 * twice answers twice. The text is the one evidence-date.ts sent (pinned in test/engine-sql-caller-raw-sql-pins.test.ts).
 */
export async function readAdmittedPageDateFields(exec: LegacyUnscopedRead, refs: readonly PageRefRow[], policy: PageReadPolicy): Promise<PageDateFieldsRow[]> {
  if (!refs.length) return [];
  const params: unknown[] = [refs.map(ref => ref.source_id), refs.map(ref => ref.slug)];
  const filter = pageReadFilter('p', policy, params, true);
  return exec.executeRaw<PageDateFieldsRow>(
    `SELECT p.source_id, p.slug, p.frontmatter, p.import_filename FROM pages p
     ${DATE_FIELDS_JOIN} WHERE ${filter}`, params,
  );
}

/** A page's observation-date inputs by id (`readPageDateFieldsByIds`). */
export interface PageDateFieldsByIdRow { id: number; slug: string; frontmatter: unknown; import_filename: string | null }

/**
 * The observation-date inputs of each of `ids` that names a page row (a soft-deleted page included, as the SQL sets
 * no filter), in no set order (search/evidence-date.ts `loadPageDateHeaders`, for page hits already read under the
 * caller's policy). The text is the one evidence-date.ts sent (pinned in test/engine-sql-caller-raw-sql-pins.test.ts).
 */
export async function readPageDateFieldsByIds(exec: LegacyUnscopedRead, ids: readonly number[]): Promise<PageDateFieldsByIdRow[]> {
  if (!ids.length) return [];
  const rows = await exec.executeRaw<{ id: number | string; slug: string; frontmatter: unknown; import_filename: string | null }>(
    'SELECT id, slug, frontmatter, import_filename FROM pages WHERE id = ANY($1::int[])', [[...ids]]);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

/** A page the walk reached: its title, type and bounded body prefix (`boundedBodyPrefixSql`). */
export interface RelationalPageRow { page_id: number; slug: string; source_id: string; title: string; type: string; synopsis: string | null }

/**
 * The refs that name a page `policy` admits (its source scope, private-page filter and trust floor; `pageReadFilter`)
 * and the search visibility clause shows (live, served text projection, unarchived source, unquarantined, no pinned
 * question, and the private-page filter when `policy.excludePrivate`), with the first 65536 code points of the body,
 * in no set order. A ref listed twice answers twice.
 */
export async function readPageSynopses(exec: LegacyUnscopedRead, refs: readonly PageRefRow[], policy?: PageReadPolicy): Promise<RelationalPageRow[]> {
  if (!refs.length) return [];
  const params: unknown[] = [refs.map(ref => ref.source_id), refs.map(ref => ref.slug)];
  const filter = pageReadFilter('p', policy, params);
  return exec.executeRaw<RelationalPageRow>(
    `SELECT p.id AS page_id, p.slug, p.source_id, p.title, p.type,
            ${boundedBodyPrefixSql('p')} AS synopsis
     FROM pages p
     JOIN sources s ON s.id = p.source_id
     ${REFS_JOIN}
     WHERE ${filter} ${buildVisibilityClause('p', 's', { excludePrivate: policy?.excludePrivate, requireSafeChunks: false })}`,
    params,
  );
}

/**
 * At most two slugs of live, unretired (`retiredPageSql`) pages of `sourceId` whose type is one of `types` and whose
 * title equals `title` case-insensitively (`lower`), in no set order. The relational arm uses a lone match as the
 * seed when entity resolution only slugified the phrase.
 */
export async function readSeedTitleSlugs(exec: LegacyUnscopedRead, sourceId: string, types: readonly string[], title: string): Promise<string[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT slug FROM pages WHERE source_id = ${sourceId} AND deleted_at IS NULL AND type = ANY(${[...types]}::text[])
           AND lower(title) = lower(${title}) AND NOT ${trustedSql(retiredPageSql('pages'))} LIMIT 2`);
  const rows = await exec.executeRaw<{ slug: string }>(text, params);
  return rows.map(row => row.slug);
}
