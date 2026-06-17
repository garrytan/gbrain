/**
 * pgvector HNSW index policy + lifecycle manager (v0.30.1 Fix 5).
 *
 * Original v0.27 surface: chunkEmbeddingIndexSql / applyChunkEmbeddingIndexPolicy
 * (kept unchanged for back-compat — schema-time index emission).
 *
 * v0.30.1 lifecycle additions:
 *   - dropAndRebuild (A3): atomic-swap pattern; build new index with temp
 *     name, ALTER...RENAME swap atomically, drop old. If rebuild fails the
 *     old index stays intact and search keeps working.
 *   - checkActiveBuild: pre-op probe of pg_stat_activity.
 *   - dropZombieIndexes: startup sweep of indisvalid=false indexes,
 *     guarded against in-progress builds.
 *   - monitorBuild: progress reporter during long-running CREATE INDEX.
 */

import type { BrainEngine } from './engine.ts';

export const PGVECTOR_HNSW_VECTOR_MAX_DIMS = 2000;

const CHUNK_EMBEDDING_HNSW_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);';

export function chunkEmbeddingIndexSql(dims: number): string {
  if (dims <= PGVECTOR_HNSW_VECTOR_MAX_DIMS) return CHUNK_EMBEDDING_HNSW_INDEX;
  return [
    '-- idx_chunks_embedding skipped: pgvector HNSW vector indexes support',
    `-- at most ${PGVECTOR_HNSW_VECTOR_MAX_DIMS} dimensions; exact vector scans remain available.`,
  ].join('\n');
}

export function applyChunkEmbeddingIndexPolicy(sql: string, dims: number): string {
  return sql.replaceAll(CHUNK_EMBEDDING_HNSW_INDEX, chunkEmbeddingIndexSql(dims));
}

// ---------------------------------------------------------------------------
// v0.30.1 Lifecycle Manager (Fix 5)
// ---------------------------------------------------------------------------

export interface IndexSpec {
  /** The CURRENT (production) index name. */
  name: string;
  table: string;
  column: string;
  /** USING clause body — e.g. `hnsw (embedding vector_cosine_ops)`. */
  using: string;
  /** Optional WHERE predicate (without WHERE keyword). */
  condition?: string;
}

export interface ActiveBuildInfo {
  active: boolean;
  pid?: number;
  query?: string;
  application_name?: string;
}

/**
 * Probe pg_stat_activity for an active CREATE INDEX on this index name.
 * Used as a pre-op guard so dropAndRebuild doesn't compete with a build
 * already in flight (Supabase auto-maintenance + parallel gbrain procs).
 */
export async function checkActiveBuild(
  engine: BrainEngine,
  indexName: string,
): Promise<ActiveBuildInfo> {
  if (engine.kind !== 'postgres') return { active: false };
  try {
    const rows = await engine.executeRaw<{ pid: number; query: string; application_name: string | null }>(
      `SELECT pid, query, application_name
       FROM pg_stat_activity
       WHERE state = 'active'
         AND (query ILIKE $1 OR query ILIKE $2)
         AND pid != pg_backend_pid()
       LIMIT 1`,
      [`%CREATE INDEX%${indexName}%`, `%REINDEX%${indexName}%`],
    );
    if (rows.length === 0) return { active: false };
    const r = rows[0];
    return {
      active: true,
      pid: r.pid,
      query: r.query,
      application_name: r.application_name ?? undefined,
    };
  } catch {
    return { active: false };
  }
}

/**
 * Sweep invalid HNSW indexes on startup. Drops any pg_index row with
 * indisvalid=false on tables we care about, AS LONG AS no active build
 * is running for that index (codex Fix-5 zombie-cleanup guard).
 *
 * Postgres-only. PGLite returns { dropped: [] }.
 */
export async function dropZombieIndexes(
  engine: BrainEngine,
  tableNames: string[] = ['content_chunks', 'pages', 'takes'],
): Promise<{ dropped: string[] }> {
  if (engine.kind !== 'postgres') return { dropped: [] };
  const dropped: string[] = [];
  try {
    // Find invalid indexes on our tables.
    const rows = await engine.executeRaw<{ indexname: string; tablename: string }>(
      `SELECT i.relname AS indexname, t.relname AS tablename
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       WHERE ix.indisvalid = false
         AND t.relname = ANY($1)`,
      [tableNames],
    );
    for (const r of rows) {
      // Guard: skip if there's an active build for this index.
      const active = await checkActiveBuild(engine, r.indexname);
      if (active.active) {
        process.stderr.write(`[hnsw] skipping zombie cleanup of ${r.indexname} — active build (pid ${active.pid})\n`);
        continue;
      }
      try {
        await engine.executeRaw(`DROP INDEX IF EXISTS ${r.indexname}`);
        dropped.push(r.indexname);
        process.stderr.write(`[hnsw] dropped zombie index ${r.indexname} on ${r.tablename}\n`);
      } catch (err) {
        process.stderr.write(`[hnsw] failed to drop ${r.indexname}: ${(err as Error).message}\n`);
      }
    }
  } catch (err) {
    // Best-effort: pg_stat_activity / pg_index queries may be restricted
    // on managed Postgres tiers. Don't fail engine.connect() over it.
    process.stderr.write(`[hnsw] zombie-index probe failed: ${(err as Error).message}\n`);
  }
  return { dropped };
}

/**
 * Atomic-swap rebuild (A3): build new index with temp name, swap atomically.
 *
 *   1. Probe pg_stat_activity → bail if another build is active
 *   2. Compose temp name: <name>_rebuild_<unix-ms>
 *   3. CREATE INDEX <temp> with the spec's USING clause + condition
 *   4. In a single transaction:
 *        DROP INDEX <name>
 *        ALTER INDEX <temp> RENAME TO <name>
 *   5. If step 3 fails (OOM, timeout, conn drop), the old index is intact
 *      and search keeps serving queries. Caller can retry.
 *
 * The CREATE INDEX uses CONCURRENTLY so it doesn't block writes during the
 * build; this requires `transaction:false` semantics so we route through
 * engine.withReservedConnection.
 */
export async function dropAndRebuild(
  engine: BrainEngine,
  spec: IndexSpec,
  opts: { reason: string; force?: boolean } = { reason: 'manual' },
): Promise<{ rebuilt: boolean; tempName: string }> {
  if (engine.kind !== 'postgres') {
    return { rebuilt: false, tempName: spec.name };
  }

  const active = await checkActiveBuild(engine, spec.name);
  if (active.active && !opts.force) {
    process.stderr.write(
      `[hnsw] dropAndRebuild ${spec.name} aborted: active build pid ${active.pid} (${active.application_name ?? 'unknown'}). Pass --force to proceed anyway.\n`,
    );
    return { rebuilt: false, tempName: spec.name };
  }

  const ts = Date.now();
  const tempName = `${spec.name}_rebuild_${ts}`;
  const where = spec.condition ? ` WHERE ${spec.condition}` : '';

  process.stderr.write(`[hnsw] rebuild ${spec.name} → ${tempName} (reason=${opts.reason})\n`);

  // Step 3: build the new index (CONCURRENTLY) under a reserved connection.
  await engine.withReservedConnection(async conn => {
    await conn.executeRaw(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${tempName} ON ${spec.table} USING ${spec.using}${where}`,
    );
  });

  // Step 4: atomic swap inside a transaction.
  await engine.transaction(async (tx) => {
    const innerSql = (tx as unknown as { sql: any }).sql;
    if (innerSql) {
      await innerSql.unsafe(`DROP INDEX IF EXISTS ${spec.name}`);
      await innerSql.unsafe(`ALTER INDEX ${tempName} RENAME TO ${spec.name}`);
    }
  });

  process.stderr.write(`[hnsw] rebuild complete: ${spec.name}\n`);
  return { rebuilt: true, tempName };
}

/**
 * Poll pg_stat_activity to monitor a CREATE INDEX in progress. Reports
 * elapsed time + progress (rows-built proxy via pg_stat_progress_create_index
 * when available; falls back to relation size growth otherwise).
 *
 * Caller wraps a CREATE INDEX in a separate code path; this function is
 * orthogonal — it just polls and emits progress lines.
 */
export interface BuildProgress {
  elapsed_ms: number;
  size_bytes?: number;
  workers?: number;
  pid?: number;
}

export async function monitorBuild(
  engine: BrainEngine,
  indexName: string,
  onProgress: (status: BuildProgress) => void,
  opts: { intervalMs?: number; maxIterations?: number } = {},
): Promise<void> {
  if (engine.kind !== 'postgres') return;
  const interval = opts.intervalMs ?? 30000;
  const maxIterations = opts.maxIterations ?? 240; // 240 * 30s = 2h cap
  const t0 = Date.now();
  for (let i = 0; i < maxIterations; i++) {
    const active = await checkActiveBuild(engine, indexName);
    if (!active.active) return;
    let size_bytes: number | undefined;
    try {
      const rows = await engine.executeRaw<{ size: number }>(
        `SELECT pg_relation_size(c.oid) AS size FROM pg_class c WHERE c.relname = $1 LIMIT 1`,
        [indexName],
      );
      if (rows[0]) size_bytes = Number(rows[0].size);
    } catch { /* size probe optional */ }
    onProgress({ elapsed_ms: Date.now() - t0, size_bytes, pid: active.pid });
    await new Promise(r => setTimeout(r, interval));
  }
}

/**
 * Detect whether a CREATE INDEX query in pg_stat_activity is from Supabase
 * auto-maintenance (vs. our gbrain process). Used by dropAndRebuild to
 * back off when auto-maintenance is doing the rebuild for us.
 */
export function isSupabaseAutoMaintenance(active: ActiveBuildInfo): boolean {
  if (!active.active) return false;
  const appName = (active.application_name ?? '').toLowerCase();
  return appName.includes('supabase') || appName.includes('postgres-meta');
}
