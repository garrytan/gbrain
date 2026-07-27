// v0.40.6.0 Schema Cathedral v3 — schema_sync pure core function.
//
// For each path_prefix declared in the active pack, find pages with
// NULL type matching that prefix and backfill `pages.type` to the
// declared type. Dry-run by default; `--apply` performs the UPDATEs.
//
// D14 chunked UPDATE: 1000-row batches. Each chunk completes in <100ms,
// releases the row lock between batches, never wedges concurrent
// writers (the bug class v0.22.1 statement_timeout work paid for).
//
// Codex C5: write-side source scoping. Mutations use the caller's
// `ctx.sourceId` directly (write authority), NOT `sourceScopeOpts`
// which is read-side and can inherit OAuth federation reads. Phase 7's
// MCP `schema_apply_mutations` op enforces this at the dispatch layer
// too.
//
// PGLite + Postgres parity via `executeRaw`.

import type { BrainEngine } from '../engine.ts';
import { loadActivePackBestEffort } from './best-effort.ts';
import type { OperationContext } from '../operations.ts';

export interface SyncOpts {
  /** Apply UPDATE statements. Default false (dry-run). */
  apply?: boolean;
  /**
   * Source ID to scope the sync. Write-side (codex C5): mutations target
   * the caller's authorized source, not read federation. Omit for whole-
   * brain sync (typically only CLI / autopilot path).
   */
  sourceId?: string;
  /** Per-batch row cap (D14). Default 1000. */
  batchSize?: number;
  /** Progress callback fired per batch on apply path. */
  onProgress?: (info: { type: string; prefix: string; appliedSoFar: number }) => void;
}

export interface PerPrefixResult {
  type: string;
  prefix: string;
  /** Untyped pages matching this prefix at dry-run time. */
  would_apply: number;
  /** Sample of slugs (capped at 10) for the agent's drilldown. */
  sample_slugs: string[];
  /** Whether the prefix matched zero pages (dead-prefix hint). */
  dead_prefix: boolean;
  /** Rows actually updated. Equal to would_apply on a clean apply,
   *  0 on dry-run, possibly less if concurrent writer claimed some. */
  applied: number;
}

export interface SyncResult {
  schema_version: 1;
  apply: boolean;
  pack_identity: string | null;
  per_prefix: PerPrefixResult[];
  /** Total rows that would be / were updated across all prefixes. */
  total_would_apply: number;
  total_applied: number;
}

/**
 * Count + sample untyped pages matching a prefix. Used by both dry-run
 * (sample is the drilldown signal) and apply (count for would_apply).
 */
async function probePrefix(
  engine: BrainEngine,
  prefix: string,
  sourceId: string | undefined,
): Promise<{ count: number; sample: string[] }> {
  let where = `WHERE deleted_at IS NULL AND (type IS NULL OR type = '') AND source_path LIKE $1`;
  const params: unknown[] = [`${prefix}%`];
  if (sourceId) {
    where += ` AND source_id = $2`;
    params.push(sourceId);
  }
  try {
    const cntRows = await engine.executeRaw<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM pages ${where}`,
      params,
    );
    const count = parseInt(cntRows[0]?.cnt ?? '0', 10) || 0;
    if (count === 0) return { count: 0, sample: [] };
    const sampleRows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages ${where} ORDER BY slug LIMIT 10`,
      params,
    );
    return { count, sample: sampleRows.map((r) => r.slug) };
  } catch {
    return { count: 0, sample: [] };
  }
}

/**
 * Apply the type assignment in 1000-row chunks (D14). Each loop
 * iteration: SELECT a window of matching IDs, UPDATE them in one
 * statement, count returned rows. Stops when a batch returns zero
 * (idempotent: re-running finds nothing to update).
 *
 * Returns the total rows updated.
 */
async function applyTypeAssignment(
  engine: BrainEngine,
  type: string,
  prefix: string,
  sourceId: string | undefined,
  batchSize: number,
  onProgress?: (appliedSoFar: number) => void,
): Promise<number> {
  let totalApplied = 0;
  let sourceWhere = '';
  // Param indices for the subquery: 1=type (used in the outer UPDATE),
  // 2=prefix, 3=batchSize, 4=sourceId (when scoped).
  const sourceParams: unknown[] = [];
  if (sourceId) {
    sourceWhere = ` AND source_id = $4`;
    sourceParams.push(sourceId);
  }
  // Loop guard: max 10000 iterations protects against runaway.
  for (let i = 0; i < 10000; i++) {
    try {
      const rows = await engine.executeRaw<{ updated: string }>(
        `WITH win AS (
           SELECT id FROM pages
           WHERE deleted_at IS NULL
             AND (type IS NULL OR type = '')
             AND source_path LIKE $2${sourceWhere}
           LIMIT $3
         ),
         upd AS (
           UPDATE pages SET type = $1
           WHERE id IN (SELECT id FROM win)
           RETURNING 1
         )
         SELECT COUNT(*)::text AS updated FROM upd`,
        [type, `${prefix}%`, batchSize, ...sourceParams],
      );
      const batchCount = parseInt(rows[0]?.updated ?? '0', 10) || 0;
      if (batchCount === 0) break;
      totalApplied += batchCount;
      onProgress?.(totalApplied);
      // Safety net: if a batch returned less than batchSize, we're done.
      if (batchCount < batchSize) break;
    } catch (e) {
      // Surface the error — sync failures are real and should fail loud.
      throw new Error(`schema sync failed at prefix '${prefix}' → type '${type}': ${(e as Error).message}`);
    }
  }
  return totalApplied;
}

/**
 * Pure core for `gbrain schema sync` (CLI) AND `schema_sync` MCP op.
 *
 * Dry-run by default: probes each declared prefix for untyped page
 * count + a 10-slug sample (the agent's drilldown signal). With
 * apply=true: chunked UPDATE per prefix.
 */
export async function runSyncCore(
  ctx: OperationContext,
  opts: SyncOpts = {},
): Promise<SyncResult> {
  const apply = opts.apply ?? false;
  const batchSize = Math.max(1, Math.min(10000, opts.batchSize ?? 1000));
  const sourceId = opts.sourceId;  // codex C5: write-side scoping

  const pack = await loadActivePackBestEffort(ctx);
  if (!pack) {
    return {
      schema_version: 1,
      apply,
      pack_identity: null,
      per_prefix: [],
      total_would_apply: 0,
      total_applied: 0,
    };
  }
  const per_prefix: PerPrefixResult[] = [];
  let total_would_apply = 0;
  let total_applied = 0;
  for (const t of pack.manifest.page_types) {
    for (const prefix of t.path_prefixes) {
      const probe = await probePrefix(ctx.engine, prefix, sourceId);
      const dead_prefix = probe.count === 0;
      let applied = 0;
      if (apply && probe.count > 0) {
        applied = await applyTypeAssignment(
          ctx.engine,
          t.name,
          prefix,
          sourceId,
          batchSize,
          (n) => opts.onProgress?.({ type: t.name, prefix, appliedSoFar: n }),
        );
      }
      per_prefix.push({
        type: t.name,
        prefix,
        would_apply: probe.count,
        sample_slugs: probe.sample,
        dead_prefix,
        applied,
      });
      total_would_apply += probe.count;
      total_applied += applied;
    }
  }
  return {
    schema_version: 1,
    apply,
    pack_identity: pack.identity,
    per_prefix,
    total_would_apply,
    total_applied,
  };
}
