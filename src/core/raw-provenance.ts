/**
 * Raw-provenance shared vocabulary (#1978).
 *
 * Three consumers have to agree on the SAME literals or the invariant is
 * unenforceable:
 *
 *   1. the WRITER — `src/core/cycle/synthesize.ts` stamps the dream-cycle
 *      index page with `raw_trace_exempt` + `raw_trace_exempt_reason`
 *      prospectively, at write time;
 *   2. the CHECK — `rawProvenanceCheck` in `src/commands/doctor.ts` flags
 *      synthesized pages that carry no trace and no exemption;
 *   3. the BACKFILL — the `dream_cycle_index_provenance` entry in
 *      `src/core/backfill-registry.ts` applies (1)'s stamp to index pages
 *      that predate the writer's stamping code.
 *
 * Keeping the predicate and the exemption literals here means the backfill
 * can never drift from the check it is meant to satisfy, and the stamp it
 * writes can never drift from the stamp the writer produces.
 */

/**
 * Slug namespace the dream cycle writes its per-cycle index page into.
 * `synthesize.ts` composes `${prefix}${YYYY-MM-DD}`.
 */
export const DREAM_CYCLE_SUMMARY_SLUG_PREFIX = 'dream-cycle-summaries/';

/**
 * SQL (POSIX ARE) pattern matching exactly the slugs the dream-cycle index
 * writer produces — namespace prefix plus an ISO date, nothing else. Narrow
 * on purpose: a hand-authored page that happens to live under the namespace
 * must NOT be auto-exempted by the backfill.
 *
 * Safe to interpolate the prefix: it is a fixed literal with no ARE
 * metacharacters (asserted by
 * test/backfill-dream-cycle-index-provenance.test.ts).
 */
export const DREAM_CYCLE_INDEX_SLUG_SQL_PATTERN =
  `^${DREAM_CYCLE_SUMMARY_SLUG_PREFIX}[0-9]{4}-[0-9]{2}-[0-9]{2}$`;

/**
 * Exemption reason stamped on the dream-cycle index page. The index is
 * deterministic — it has no source document of its own; the raw traces live
 * on the pages it lists.
 */
export const DREAM_INDEX_RAW_TRACE_EXEMPT_REASON =
  'deterministic dream-cycle index; raw traces live on listed pages';

/**
 * Frontmatter keys that satisfy the raw-provenance invariant. Kept as one
 * list so the doctor predicate and any future consumer share it.
 */
export const RAW_TRACE_FRONTMATTER_KEYS = [
  'raw_trace',
  'raw_source',
  'source_uri',
  'raw_trace_exempt',
] as const;

/**
 * SQL predicate naming synthesized/derived pages that carry NO raw trace and
 * NO explicit exemption — i.e. the rows `doctor`'s `raw_provenance` check
 * warns about.
 *
 * `alias` is the table alias (or table name) the caller qualifies `pages`
 * columns with. It is developer-supplied, never user input, and is validated
 * as a bare SQL identifier before interpolation.
 */
export function untracedSynthesizedPagesPredicate(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`untracedSynthesizedPagesPredicate: invalid SQL alias ${JSON.stringify(alias)}`);
  }
  const traceKeys = RAW_TRACE_FRONTMATTER_KEYS.map(k => `'${k}'`).join(', ');
  return `
        ${alias}.deleted_at IS NULL
    AND (COALESCE(${alias}.frontmatter->>'dream_generated', '') = 'true' OR ${alias}.type = 'synthesis')
    AND NOT (COALESCE(${alias}.frontmatter, '{}'::jsonb) ?| ARRAY[${traceKeys}])
    AND NOT EXISTS (SELECT 1 FROM raw_data rd WHERE rd.page_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM synthesis_evidence se WHERE se.synthesis_page_id = ${alias}.id)`;
}
