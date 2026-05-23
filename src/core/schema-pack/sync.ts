// Schema cathedral v2 — `gbrain schema sync`.
//
// Backfill page.type for rows whose source_path matches an active-pack
// type's path_prefixes but whose `type` column is NULL or empty. This
// closes the gap between filesystem state (which the brain wrote) and
// the canonical typed view (which the schema pack defines).
//
// Defaults to dry-run. Pass `apply: true` to actually issue updates.
// Each prefix is processed independently; the result reports how many
// rows would (or did) move per type. The set of rows considered is
// always deleted_at IS NULL.
//
// SQL safety:
//   - Prefix is bound as a literal string parameter with `LIKE $2`.
//   - The trailing '%' is appended inside the function, never accepted
//     from caller input directly.
//   - Pack manifest path_prefixes are constrained by the manifest schema
//     (strings only), so injection surface is limited to whatever the
//     pack author wrote into their own pack file.

import type { BrainEngine } from '../engine.ts';
import { loadActivePack } from './load-active.ts';
import { loadConfig } from '../config.ts';

export interface SyncOpts {
  /** Restrict the update to a single source_id. Omit for all sources. */
  sourceId?: string;
  /** Default false — dry-run. Pass true to write. */
  apply?: boolean;
}

export interface SyncPerType {
  type: string;
  prefixes: string[];
  matched: number;
}

export interface SyncResult {
  applied: boolean;
  pack: string;
  source_id: string | null;
  total_matched: number;
  per_type: SyncPerType[];
}

interface CountRow { cnt: string | number }

export async function runSync(engine: BrainEngine, opts: SyncOpts = {}): Promise<SyncResult> {
  const sourceId = opts.sourceId ?? null;
  const apply = Boolean(opts.apply);

  const cfg = loadConfig();
  const pack = await loadActivePack({
    cfg,
    remote: false,
    ...(sourceId ? { sourceId } : {}),
  });

  const per_type: SyncPerType[] = [];
  let total_matched = 0;

  for (const t of pack.manifest.page_types) {
    if (!t.path_prefixes || t.path_prefixes.length === 0) continue;
    let matched = 0;
    for (const prefix of t.path_prefixes) {
      const like = `${prefix}%`;
      if (apply) {
        // For Postgres we'd lean on RETURNING for atomic count; PGLite
        // doesn't always surface RETURNING through executeRaw, so we
        // run a count-then-update pair inside the same SQL plan.
        const cntRows = await engine.executeRaw<CountRow>(
          `SELECT COUNT(*)::text AS cnt FROM pages
             WHERE deleted_at IS NULL
               AND (type IS NULL OR type = '')
               AND source_path LIKE $1
               ${sourceId ? 'AND source_id = $2' : ''}`,
          sourceId ? [like, sourceId] : [like],
        );
        const n = Number(cntRows[0]?.cnt ?? 0);
        if (n > 0) {
          await engine.executeRaw(
            `UPDATE pages SET type = $1
               WHERE deleted_at IS NULL
                 AND (type IS NULL OR type = '')
                 AND source_path LIKE $2
                 ${sourceId ? 'AND source_id = $3' : ''}`,
            sourceId ? [t.name, like, sourceId] : [t.name, like],
          );
        }
        matched += n;
      } else {
        const cntRows = await engine.executeRaw<CountRow>(
          `SELECT COUNT(*)::text AS cnt FROM pages
             WHERE deleted_at IS NULL
               AND (type IS NULL OR type = '')
               AND source_path LIKE $1
               ${sourceId ? 'AND source_id = $2' : ''}`,
          sourceId ? [like, sourceId] : [like],
        );
        matched += Number(cntRows[0]?.cnt ?? 0);
      }
    }
    if (matched > 0) {
      per_type.push({ type: t.name, prefixes: t.path_prefixes, matched });
      total_matched += matched;
    }
  }

  // Sort descending by matched count for human-friendly output.
  per_type.sort((a, b) => b.matched - a.matched);

  return {
    applied: apply,
    pack: pack.manifest.name,
    source_id: sourceId,
    total_matched,
    per_type,
  };
}
