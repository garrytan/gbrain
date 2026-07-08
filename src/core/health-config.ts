/**
 * Health-metric configuration knobs (env-gated, default OFF).
 *
 * `getHealth().orphan_pages` counts "islanded" pages — no inbound AND no
 * outbound link. Machine-generated chrome (code-artifact pointers, ingest /
 * extract / self-test / freshness logs) is islanded by nature: it references no
 * entity and nothing references it, so it inflates the orphan count without
 * signalling a real knowledge-graph gap. On a brain that ingests a lot of such
 * chrome the metric reads ~46% orphaned while the human-knowledge graph is
 * healthy.
 *
 * `GBRAIN_HEALTH_ORPHAN_EXCLUDE_TYPES` is a comma-separated list of page `type`s
 * to drop from the orphan count. Unset / empty = count every type (the upstream
 * default — this module is a pure no-op until the operator opts in). Mirrors the
 * existing `GBRAIN_SEARCH_EXCLUDE` env pattern in `search/source-boost.ts`.
 *
 * Reversible: unset the env var to restore the count-everything behavior.
 */

// Page types are lowercase kebab/underscore tokens (e.g. `artifact_pointer`,
// `selftest-run`). Validate strictly so a fragment built from this list can be
// interpolated into SQL with no injection surface (operator-set env only, but
// keep it fail-closed regardless).
const TYPE_TOKEN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Parse the configured orphan-exclusion page types. Returns [] when unset/empty
 * or when every token is malformed — i.e. the safe, count-everything default.
 */
export function resolveOrphanExcludeTypes(
  envValue: string | undefined = process.env.GBRAIN_HEALTH_ORPHAN_EXCLUDE_TYPES,
): string[] {
  if (!envValue) return [];
  return envValue
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && TYPE_TOKEN.test(s));
}

/**
 * SQL fragment (leading-space, or '') that excludes the configured chrome types
 * from an orphan subquery. For the raw-string engine (PGLite). Types are
 * validated against `TYPE_TOKEN` before interpolation.
 *
 *   orphanTypeExcludeClause('p')  // "" | " AND p.type NOT IN ('artifact_pointer', ...)"
 */
export function orphanTypeExcludeClause(
  pageAlias: string,
  envValue?: string,
): string {
  const types = resolveOrphanExcludeTypes(envValue);
  if (types.length === 0) return '';
  const list = types.map((t) => `'${t}'`).join(', ');
  return ` AND ${pageAlias}.type NOT IN (${list})`;
}
