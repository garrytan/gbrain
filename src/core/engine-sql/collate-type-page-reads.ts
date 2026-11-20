/**
 * The page reads of the schema-pack conversions (`schema retype` and the page-to-alias / page-to-link phases of unify-types)
 * that ran through `executeRaw`, each with the statement text and parameters its caller used; only its home moved. Every
 * one orders by slug in byte order (`COLLATE "C"`), so the sample a dry run shows, and the pages a bounded run takes, are
 * the same on every engine whatever the database locale is (test/engine-parity/collate-schema-pack-samples.test.ts). The
 * text of each is pinned in test/engine-sql-caller-raw-sql-pins.test.ts.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { joinFragments, renderFragment, sqlFragment, type SqlFragment } from './fragment.ts';

/** A live page of one type with the fields the conversions resolve their slugs from. `compiled_truth` is null for a segmented page. */
export interface TypePageBody {
  slug: string;
  compiled_truth: string | null;
  frontmatter: Record<string, unknown> | string | null;
}

function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`limit must be a whole number of at least 1, got ${limit}`);
  return limit;
}

/**
 * The live pages of `type` (in `sourceId` when given), by slug then id in byte order, up to `limit`
 * (schema-pack/page-to-link.ts `runPageToLinkCore`).
 */
export async function listTypePageBodies(
  raw: EngineRawRead,
  opts: { type: string; sourceId?: string; limit: number },
): Promise<TypePageBody[]> {
  const where = opts.sourceId
    ? sqlFragment`WHERE deleted_at IS NULL AND type = ${opts.type} AND source_id = ${opts.sourceId}`
    : sqlFragment`WHERE deleted_at IS NULL AND type = ${opts.type}`;
  const { text, params } = renderFragment(sqlFragment`SELECT slug, compiled_truth, frontmatter FROM pages ${where} ORDER BY slug COLLATE "C", id`);
  return raw<TypePageBody>(`${text} LIMIT ${checkedLimit(opts.limit)}`, params);
}

/**
 * The live pages of `type` in `sourceId`, by slug in byte order, up to `limit` (schema-pack/page-to-alias.ts
 * `runPageToAliasCore`).
 */
export async function listSourceTypePageBodies(
  raw: EngineRawRead,
  opts: { type: string; sourceId: string; limit: number },
): Promise<TypePageBody[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT slug, compiled_truth, frontmatter FROM pages WHERE deleted_at IS NULL AND type = ${opts.type} AND source_id = ${opts.sourceId} ORDER BY slug COLLATE "C"`);
  return raw<TypePageBody>(`${text} LIMIT ${checkedLimit(opts.limit)}`, params);
}

/** The filters of a retype rule: `pathFilter` and `slugFilter` are `LIKE` patterns on the page's source path and slug. */
export interface RetypeProbeOpts { fromType: string; pathFilter?: string; slugFilter?: string; sourceId?: string }

function retypeWhere(opts: RetypeProbeOpts): SqlFragment {
  const parts: SqlFragment[] = [sqlFragment`deleted_at IS NULL`, sqlFragment`type = ${opts.fromType}`];
  if (opts.pathFilter) parts.push(sqlFragment`source_path LIKE ${opts.pathFilter}`);
  if (opts.slugFilter) parts.push(sqlFragment`slug LIKE ${opts.slugFilter}`);
  if (opts.sourceId) parts.push(sqlFragment`source_id = ${opts.sourceId}`);
  return joinFragments(parts, ' AND ');
}

/** How many live pages of `fromType` match the filters (schema-pack/retype.ts `probeRule`). */
export async function countRetypeCandidates(raw: EngineRawRead, opts: RetypeProbeOpts): Promise<number> {
  const { text, params } = renderFragment(sqlFragment`SELECT COUNT(*)::text AS cnt FROM pages WHERE ${retypeWhere(opts)}`);
  const rows = await raw<{ cnt: string }>(text, params);
  return parseInt(rows[0]?.cnt ?? '0', 10) || 0;
}

/** The first ten slugs, in byte order, of the live pages of `fromType` that match the filters (schema-pack/retype.ts `probeRule`). */
export async function listRetypeSampleSlugs(raw: EngineRawRead, opts: RetypeProbeOpts): Promise<string[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT slug FROM pages WHERE ${retypeWhere(opts)} ORDER BY slug COLLATE "C" LIMIT 10`);
  return (await raw<{ slug: string }>(text, params)).map((r) => r.slug);
}
