/**
 * Source-scope resolution for search/query operations (v0.20+).
 *
 * v0.18.0 added multi-source brains. The migration's pitch — "Cross-source
 * search is opt-in per source (federated=true) so isolated content never
 * bleeds into your main brain" — was advertised but never enforced at the
 * search layer: SearchOpts had no source filter and both engines'
 * searchKeyword/searchVector ran across every page row regardless of which
 * source the caller's CLI / MCP context belonged to.
 *
 * resolveSearchScope is the missing piece. The search/query operation
 * handlers call it once per request to convert "no explicit source list"
 * into the concrete set of source ids the caller is allowed to read:
 *
 *   1. The caller's resolved current source (resolveSourceId() result).
 *   2. Every source whose `config.federated = true`.
 *
 * The two are unioned and deduped. Sources without `config.federated = true`
 * are isolated by default and only show up in a search when the caller
 * explicitly names them (passes `source_ids: [...]` in the op params, or
 * runs with --source set / cwd inside that source's local_path).
 *
 * If the caller passes an explicit list, that list wins verbatim — we
 * don't merge in federated sources, because the operator's intent was to
 * scope to exactly that set.
 */

import type { BrainEngine } from './engine.ts';
import { resolveSourceId } from './source-resolver.ts';

const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Resolve the set of source ids this search request may read.
 *
 * @param engine    Connected brain engine.
 * @param explicit  Caller-supplied source ids. Empty / undefined falls
 *                  through to the default scope. When present, every id
 *                  must match the same SOURCE_ID_RE the resolver uses.
 * @param explicitCurrent The caller's --source flag value (if any). Falls
 *                  through to resolveSourceId()'s normal lookup chain
 *                  (env, dotfile, registered local_path, brain default).
 * @returns         A non-empty deduped list of source ids. Always includes
 *                  the current source so a search returns the operator's
 *                  own brain by default. Throws on malformed explicit ids.
 */
export async function resolveSearchScope(
  engine: BrainEngine,
  explicit: string[] | null | undefined,
  explicitCurrent?: string | null,
): Promise<string[]> {
  if (explicit && explicit.length > 0) {
    for (const id of explicit) {
      if (!SOURCE_ID_RE.test(id)) {
        throw new Error(`Invalid source id "${id}" in source_ids. Must match [a-z0-9-]{1,32}.`);
      }
    }
    return Array.from(new Set(explicit));
  }

  const current = await resolveSourceId(engine, explicitCurrent ?? null);

  const federated = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE config IS NOT NULL AND config->>'federated' = 'true'`,
  );

  const out = new Set<string>([current]);
  for (const r of federated) out.add(r.id);
  return Array.from(out);
}
