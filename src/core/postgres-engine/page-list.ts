import type postgres from 'postgres';
import type { PageFrontmatterFilter } from '../types.ts';

/** Builds the parameterized frontmatter predicate for Postgres list-pages queries. */
export function buildFrontmatterListPagePredicate(
  sql: ReturnType<typeof postgres>,
  filters: readonly PageFrontmatterFilter[] | undefined,
) {
  const serialized = filters?.length ? JSON.stringify(filters) : null;
  if (!serialized) return sql``;

  return sql`AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(${serialized}::text::jsonb) AS fm_clause(value)
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
  )`;
}
