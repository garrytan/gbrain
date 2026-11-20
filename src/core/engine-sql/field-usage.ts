/**
 * Field usage sample read: the page type counts and per-type page samples of `gbrain schema detect --fields`
 * (`schema-pack/field-usage.ts` runFieldUsage), which ran through `engine.executeRaw`, once for both engines.
 *
 * The read runs unscoped, as on master. It keeps two master behaviours (TODOS.md): it does not join `sources`, so
 * pages of an archived source are counted and sampled; and a segmented page (compiled_truth NULL, its body in
 * segments) is sampled with a null body, which the caller reads as empty. Each value is a bound parameter.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment } from './fragment.ts';
import { rows } from './search-reads.ts';

export interface FieldUsageQuery {
  /** One source; omitted reads the whole brain. */
  sourceId?: string;
  /** The most page types to return. */
  maxTypes: number;
  /** The most pages to sample per type (at least 1). */
  samplePerType: number;
  /** One page type; omitted reads every type. */
  type?: string;
  /** True returns the types and counts with no sampled pages. */
  countsOnly?: boolean;
}

/** One sampled page: its frontmatter object and its compiled_truth (null for a segmented page). */
export interface FieldUsageSampleRow { frontmatter: Record<string, unknown>; compiled_truth: string | null }

/** One page type of the scope: its live page count and the sample of its oldest live pages. */
export interface FieldUsageTypeSample { type: string; pages: number; rows: FieldUsageSampleRow[] }

function frontmatterObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return (value ?? {}) as Record<string, unknown>;
}

/**
 * The live page types of the scope with their page counts, most pages first, ties in byte order, at most `maxTypes`;
 * per type, the frontmatter and compiled_truth of at most `samplePerType` live pages in page id order. Pages carry no
 * id in the answer. `type` narrows the read to one type; `countsOnly` skips the samples, so a caller can read the
 * types first and then one type's sample at a time, never holding every type's bodies at once.
 */
export async function readFieldUsageSamples(exec: LegacyUnscopedRead, query: FieldUsageQuery): Promise<FieldUsageTypeSample[]> {
  const scope = query.sourceId !== undefined && query.sourceId !== ''
    ? sqlFragment` AND pages.source_id = ${query.sourceId}` : sqlFragment``;
  const only = query.type !== undefined ? sqlFragment` AND pages.type = ${query.type}` : sqlFragment``;
  const types = await rows<{ type: string; pages: number }>(exec, sqlFragment`SELECT pages.type, count(*)::int AS pages FROM pages
      WHERE pages.deleted_at IS NULL AND coalesce(pages.type, '') <> ''${scope}${only}
      GROUP BY pages.type ORDER BY count(*) DESC, pages.type LIMIT ${Math.max(0, Math.floor(query.maxTypes))}`);
  const sample = Math.max(1, Math.floor(query.samplePerType));
  const out: FieldUsageTypeSample[] = [];
  for (const { type, pages } of types) {
    if (query.countsOnly === true) { out.push({ type: String(type), pages: Number(pages), rows: [] }); continue; }
    const sampled = await rows<{ frontmatter: unknown; compiled_truth: string | null }>(exec, sqlFragment`SELECT pages.frontmatter, pages.compiled_truth FROM pages
        WHERE pages.deleted_at IS NULL AND pages.type = ${type}${scope}
        ORDER BY pages.id LIMIT ${sample}`);
    out.push({ type: String(type), pages: Number(pages),
      rows: sampled.map((r) => ({ frontmatter: frontmatterObject(r.frontmatter), compiled_truth: r.compiled_truth ?? null })) });
  }
  return out;
}
