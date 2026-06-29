// v0.40.6.0 Schema Cathedral v3 — schema_stats pure core function.
//
// Reports per-type page counts, untyped-coverage percentage, and
// dead-prefix detection (declared prefix with zero matching pages —
// a "this type has no content" signal that helps agents spot
// mis-declared paths).
//
// Multi-source aware: accepts `sourceIds` (federated read) OR
// `sourceId` (single) OR nothing (aggregate across all sources). Uses
// the same WHERE shape as the rest of the read-path codebase.
//
// PGLite + Postgres parity via `executeRaw`. Soft-deletes filtered.
//
// Pure core: returns structured data; CLI handler in Phase 4 wraps
// for human + JSON output, MCP handler in Phase 7 wires it through
// the operation envelope.

import type { BrainEngine } from '../engine.ts';
import { loadActivePackBestEffort } from './best-effort.ts';
import type { OperationContext } from '../operations.ts';
import { isUndefinedTableError } from '../utils.ts';

export interface StatsOpts {
  /** Single source scope. Omit + omit sourceIds for whole-brain aggregate. */
  sourceId?: string;
  /** Federated read scope (overrides sourceId when set). */
  sourceIds?: string[];
}

export interface TypeStats {
  /** Type name as it appears in the DB `pages.type` column. */
  type: string;
  /** Page count for this type within the scope. */
  count: number;
}

export interface PerSourceStats {
  source_id: string;
  total_pages: number;
  typed_pages: number;
  untyped_pages: number;
  coverage: number;
  by_type: TypeStats[];
}

export interface DeadPrefixHint {
  /** Type name declared in the pack. */
  type: string;
  /** Prefix declared in the pack with zero matching DB pages. */
  prefix: string;
}

export interface StatsResult {
  schema_version: 1;
  /** Pack identity at stats time (null when no pack loaded). */
  pack_identity: string | null;
  /** Aggregate across all scoped sources. */
  aggregate: PerSourceStats;
  /** Per-source breakdown when multiple sources are in scope. */
  per_source: PerSourceStats[];
  /** Pack-declared prefixes that match zero pages — likely mis-declared. */
  dead_prefixes: DeadPrefixHint[];
}

interface RawCountRow {
  source_id: string | null;
  type: string | null;
  cnt: string;
}

function computeCoverage(typed: number, total: number): number {
  if (total === 0) return 1.0;  // vacuous truth — matches getBrainScore pattern
  return Math.round((typed / total) * 10000) / 10000;
}

function aggregateRows(rows: RawCountRow[]): PerSourceStats[] {
  const bySource = new Map<string, { typed: number; untyped: number; total: number; byType: Map<string, number> }>();
  for (const r of rows) {
    const sid = r.source_id ?? 'default';
    const cnt = parseInt(r.cnt, 10) || 0;
    if (!bySource.has(sid)) {
      bySource.set(sid, { typed: 0, untyped: 0, total: 0, byType: new Map() });
    }
    const bucket = bySource.get(sid)!;
    if (r.type === null || r.type === '') {
      bucket.untyped += cnt;
    } else {
      bucket.typed += cnt;
      bucket.byType.set(r.type, (bucket.byType.get(r.type) ?? 0) + cnt);
    }
    bucket.total += cnt;
  }
  const out: PerSourceStats[] = [];
  for (const [sid, b] of bySource) {
    out.push({
      source_id: sid,
      total_pages: b.total,
      typed_pages: b.typed,
      untyped_pages: b.untyped,
      coverage: computeCoverage(b.typed, b.total),
      by_type: [...b.byType.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    });
  }
  // Sort sources alphabetically for stable output.
  out.sort((a, b) => a.source_id.localeCompare(b.source_id));
  return out;
}

function mergeAggregate(per: PerSourceStats[]): PerSourceStats {
  let typed = 0, untyped = 0, total = 0;
  const byType = new Map<string, number>();
  for (const s of per) {
    typed += s.typed_pages;
    untyped += s.untyped_pages;
    total += s.total_pages;
    for (const t of s.by_type) byType.set(t.type, (byType.get(t.type) ?? 0) + t.count);
  }
  return {
    source_id: '*',
    total_pages: total,
    typed_pages: typed,
    untyped_pages: untyped,
    coverage: computeCoverage(typed, total),
    by_type: [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  };
}

/**
 * Query the DB for stats. Multi-source aware:
 *   - sourceIds[] → WHERE source_id = ANY($1::text[])
 *   - sourceId    → WHERE source_id = $1
 *   - neither     → no source filter (whole brain)
 *
 * Always: `WHERE deleted_at IS NULL`.
 *
 * Returns rows grouped by (source_id, type) so we can compute per-source
 * + aggregate in one read.
 */
async function fetchCountRows(engine: BrainEngine, opts: StatsOpts): Promise<RawCountRow[]> {
  let where = 'WHERE deleted_at IS NULL';
  const params: unknown[] = [];
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    where += ` AND source_id = ANY($1::text[])`;
    params.push(opts.sourceIds);
  } else if (opts.sourceId) {
    where += ` AND source_id = $1`;
    params.push(opts.sourceId);
  }
  // pages.type is NOT NULL in the schema — empty string represents
  // "untyped" (legacy + put_page fallback per D12). Normalize both
  // empty-string and NULL to the same bucket via NULLIF.
  const sql = `
    SELECT
      COALESCE(source_id, 'default') AS source_id,
      NULLIF(type, '') AS type,
      COUNT(*)::text AS cnt
    FROM pages
    ${where}
    GROUP BY source_id, NULLIF(type, '')
    ORDER BY source_id, NULLIF(type, '') NULLS LAST
  `;
  try {
    return await engine.executeRaw<RawCountRow>(sql, params);
  } catch (err) {
    // ONLY swallow the genuine "pages table doesn't exist yet" case
    // (empty / pre-init brain). #2466: the old bare `catch {}` masked
    // EVERY error — so any engine-level failure (connection, version
    // skew, a query incompatibility) was silently converted to 0 rows,
    // printing "Total pages: 0" on a populated brain and cascading into
    // false "100% coverage" + a starved `schema suggest`. Surface
    // everything that is not a missing-table error so the real failure
    // is visible instead of hidden behind a fake zero.
    if (isUndefinedTableError(err)) return [];
    throw err;
  }
}

/**
 * Per-prefix existence check for dead-prefix detection. One COUNT(*)
 * per declared prefix in the active pack. Cheap on small brains;
 * Phase 4 CLI offers a `--no-dead-prefix-scan` flag to opt out on
 * brains where this matters.
 */
async function detectDeadPrefixes(
  engine: BrainEngine,
  pack: { manifest: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } },
  opts: StatsOpts,
): Promise<DeadPrefixHint[]> {
  const hints: DeadPrefixHint[] = [];
  let sourceWhere = '';
  const sourceParam: unknown[] = [];
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    sourceWhere = ` AND source_id = ANY($2::text[])`;
    sourceParam.push(opts.sourceIds);
  } else if (opts.sourceId) {
    sourceWhere = ` AND source_id = $2`;
    sourceParam.push(opts.sourceId);
  }
  for (const t of pack.manifest.page_types) {
    for (const prefix of t.path_prefixes) {
      try {
        const rows = await engine.executeRaw<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM pages
           WHERE deleted_at IS NULL
             AND source_path LIKE $1${sourceWhere}`,
          [`${prefix}%`, ...sourceParam],
        );
        const cnt = parseInt(rows[0]?.cnt ?? '0', 10) || 0;
        if (cnt === 0) {
          hints.push({ type: t.name, prefix });
        }
      } catch (err) {
        // #2466: only skip on the genuine "no pages table yet" case;
        // rethrow any other engine error so it isn't silently masked.
        if (isUndefinedTableError(err)) continue;
        throw err;
      }
    }
  }
  return hints;
}

/**
 * Pure core for `gbrain schema stats` (CLI) AND `schema_stats` MCP op.
 * Returns the StatsResult ready for human-formatter, JSON output, or
 * operation envelope wrapping.
 */
export async function runStatsCore(
  ctx: OperationContext,
  opts: StatsOpts = {},
): Promise<StatsResult> {
  const rows = await fetchCountRows(ctx.engine, opts);
  const per_source = aggregateRows(rows);
  const aggregate = mergeAggregate(per_source);

  // Pack identity + dead-prefix scan — best-effort.
  let pack_identity: string | null = null;
  let dead_prefixes: DeadPrefixHint[] = [];
  const pack = await loadActivePackBestEffort(ctx);
  if (pack) {
    pack_identity = pack.identity;
    dead_prefixes = await detectDeadPrefixes(ctx.engine, pack, opts);
  }

  return {
    schema_version: 1,
    pack_identity,
    aggregate,
    per_source,
    dead_prefixes,
  };
}
