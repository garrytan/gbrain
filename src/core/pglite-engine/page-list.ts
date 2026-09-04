import type { PageFrontmatterFilter } from '../types.ts';

/** Adds validated frontmatter clauses to PGLite's positional list-pages query. */
export function appendFrontmatterListPagePredicate(
  filters: readonly PageFrontmatterFilter[] | undefined,
  params: unknown[],
  where: string[],
): void {
  if (!filters?.length) return;

  params.push(JSON.stringify(filters));
  const index = params.length;
  where.push(`NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements($${index}::text::jsonb) AS fm_clause(value)
    WHERE
      jsonb_typeof(p.frontmatter -> (fm_clause.value ->> 'field')) IS DISTINCT FROM 'string'
      OR CASE fm_clause.value ->> 'operator'
        WHEN 'eq_ci' THEN
          lower(p.frontmatter ->> (fm_clause.value ->> 'field')) <> lower(fm_clause.value ->> 'value')
        WHEN 'contains_any_ci' THEN NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(fm_clause.value -> 'values') AS needle(value)
          WHERE strpos(lower(p.frontmatter ->> (fm_clause.value ->> 'field')), lower(needle.value)) > 0
        )
        ELSE TRUE
      END
  )`);
}
