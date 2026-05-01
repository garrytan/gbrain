import type { SearchOpts } from '../types.ts';

/**
 * Build the SQL predicate for multi-source search visibility.
 *
 * Contract:
 * - opts.sourceId === concrete id: restrict to that source.
 * - opts.sourceId === '__all__': include every source, including isolated ones.
 * - opts.sourceId undefined/null: cross-source search sees only federated sources.
 *
 * The default source is always visible as a backward-compatible fallback for
 * pre-source brains and for installs where its config was not explicitly set.
 */
export function buildSourceVisibilityClause(
  opts: SearchOpts | undefined,
  params: unknown[],
  pageAlias = 'p',
): string {
  if (opts?.sourceId === '__all__') return '';

  if (opts?.sourceId) {
    params.push(opts.sourceId);
    return `AND ${pageAlias}.source_id = $${params.length}`;
  }

  return `AND (
    ${pageAlias}.source_id = 'default'
    OR EXISTS (
      SELECT 1
        FROM sources source_visibility
       WHERE source_visibility.id = ${pageAlias}.source_id
         AND COALESCE(source_visibility.config->>'federated', 'false') = 'true'
    )
  )`;
}
