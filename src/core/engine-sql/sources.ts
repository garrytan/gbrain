/**
 * Sources: one SQL implementation for both engines (refactor wave 1,
 * W1-extended). Statement text is PostgresEngine's master text (SQL-text
 * golden `sql-text/sources.json`); PGLite runs the same statements
 * (docs/designs/refactor-wave-1/w1-inventory.md). `listAllSources` was
 * unscoped on master (EO4 inventory), so it takes `LegacyUnscopedRead`.
 */
import type { SourceDetailRow, SourceRow } from '../engine.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { jsonbParam, type SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

export async function listAllSources(exec: LegacyUnscopedRead, opts?: {
  includeArchived?: boolean;
  localPathOnly?: boolean;
}): Promise<SourceRow[]> {
    // v0.38: lean per-source enumeration for autopilot dispatch + doctor.
    // Filters at SQL so the autopilot tick stays one query regardless of
    // how many archived rows exist. ORDER BY (id='default') DESC, id
    // matches sources-ops.listSources for operator-output stability.
    // localPathOnly skips pure-DB sources so autopilot fan-out doesn't
    // dispatch jobs that would fall back to the global sync.repo_path, and
    // the storage shelf, whose cycle is always skipped (GST-1943).
    const includeArchived = opts?.includeArchived === true;
    const localPathOnly = opts?.localPathOnly === true;
    const { rows } = await exec.run(sqlFragment`
      SELECT id, name, local_path, last_sync_at, config
        FROM sources
       WHERE (${includeArchived} OR archived IS NOT TRUE)
         AND (${!localPathOnly} OR (local_path IS NOT NULL AND config->>'role' IS DISTINCT FROM 'storage_manifest'))
       ORDER BY (id = 'default') DESC, id
    `);
    return rows.map((r) => ({
      id: r.id as string,
      name: (r.name as string | null) ?? null,
      local_path: (r.local_path as string | null) ?? null,
      last_sync_at: r.last_sync_at ? new Date(r.last_sync_at as string) : null,
      config: typeof r.config === 'string' ? JSON.parse(r.config) : ((r.config as Record<string, unknown> | null) ?? {}),
    }));
  }

export async function updateSourceConfig(exec: SqlExecutor, sourceId: string, patch: Record<string, unknown>): Promise<boolean> {
    // Atomic single-statement merge. The previous read-then-write form dropped
    // concurrent updates: two callers patching different keys could both read
    // the same old config and the later `SET config = ...` clobbered the
    // earlier patch. These keys are written by background cycle/autopilot
    // paths, so the merge must happen inside the UPDATE.
    //
    // The shared SQL coercion normalizes historical bad shapes inline (so
    // `config` is re-read against the row-locked latest version — a detached
    // read/normalize/write cycle would reintroduce the lost-update race under
    // READ COMMITTED): older code paths
    // could store config as a JSONB string (double-encoded) or as a JSONB array
    // of patch objects. We coerce those to a flat object before the `||` merge
    // so doctor and source routing keep getting flat keys.
    //
    // String branch guard: a JSONB string whose inner text is NOT itself valid
    // JSON (one of the historical bad shapes this path repairs) would make the
    // bare `::jsonb` cast raise `invalid input syntax for type json`, failing
    // the whole UPDATE. Postgres has no `try_cast`, so the cast goes through
    // gbrain_try_jsonb (NULL on unparseable text; Postgres 15+, unlike IS JSON,
    // #7112): parseable inner text is double-encoded config and gets parsed;
    // unparseable text falls back to `{}`.
    // The guard keeps the merge a single atomic statement (no extra round-trip,
    // no lost-update race).
    //
    // MUST bind the patch through jsonbParam (postgres.js `sql.json` on
    // Postgres) — a JSON.stringify'd string bound to `$1::jsonb` through
    // postgres-js's positional path DOUBLE-ENCODES into a JSONB STRING
    // shape instead of OBJECT. `||` between JSONB object + JSONB string
    // yields a JSONB ARRAY (concat semantics for non-matching types),
    // which wipes every existing config key.
    const { affectedRows } = await exec.run(sqlFragment`
      UPDATE sources
         SET config = ${trustedSql(SOURCE_CONFIG_OBJECT_SQL)}
           || ${jsonbParam(patch)}
       WHERE id = ${sourceId}
    `);
    return affectedRows > 0;
  }

/** One source row with the columns a source check reads: its checkout path, raw config and archived flag. */
export interface SourceCheckRow { id: string; local_path: string | null; config: unknown; archived: boolean }

/** The source row, or null (`SELECT id, local_path, config, archived FROM sources WHERE id=$1`). Unscoped on master. */
export async function readSourceRow(exec: LegacyUnscopedRead, sourceId: string): Promise<SourceCheckRow | null> {
  const [row] = await exec.executeRaw<SourceCheckRow>('SELECT id, local_path, config, archived FROM sources WHERE id=$1', [sourceId]);
  return row ?? null;
}

/** The source row read `FOR UPDATE`, so it cannot change before the caller's transaction ends; null when absent. */
export async function lockSourceRow(exec: SqlExecutor, sourceId: string): Promise<SourceCheckRow | null> {
  const [row] = await exec.executeRaw<SourceCheckRow>('SELECT id, local_path, config, archived FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
  return row ?? null;
}

/** The chunker version the source's last full sync stamped, or null. Unscoped on master. */
export async function readSourceChunkerVersion(exec: LegacyUnscopedRead, sourceId: string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ chunker_version: string | null }>('SELECT chunker_version FROM sources WHERE id = $1', [sourceId]);
  return row?.chunker_version ?? null;
}

/** Stamps the chunker version a full sync of the source used; an unknown source changes nothing. */
export async function setSourceChunkerVersion(exec: SqlExecutor, sourceId: string, version: string): Promise<void> {
  await exec.executeRaw('UPDATE sources SET chunker_version = $1 WHERE id = $2', [version, sourceId]);
}

/**
 * Ids of live sources whose last sync is more than seven days old by the database clock (`now()`), by id: the
 * advisor's stale-sync read. Unscoped on master. Throws on a schema without `last_sync_at` or `archived`.
 */
export async function listStaleSyncSourceIds(exec: LegacyUnscopedRead): Promise<string[]> {
  const rows = await exec.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE last_sync_at IS NOT NULL AND last_sync_at < now() - interval '7 days' AND NOT archived ORDER BY id`,
  );
  return rows.map(r => r.id);
}

/** One source with the columns import and contextual retrieval read, or null for an unknown id. Rows come back as the driver returns them. */
export async function getSource(exec: LegacyUnscopedRead, sourceId: string): Promise<SourceDetailRow | null> {
  const rows = await exec.executeRaw<SourceDetailRow>(
    `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at,
            contextual_retrieval_mode, trust_frontmatter_overrides
     FROM sources WHERE id = $1`,
    [sourceId],
  );
  return rows[0] ?? null;
}

/**
 * Local paths of every source that has one, unscoped on master (`withSourceFilesystemLock` read it through
 * `executeRaw`). Empty strings are dropped as well as NULLs.
 */
export async function listSourceLocalPaths(exec: LegacyUnscopedRead): Promise<string[]> {
  const { rows } = await exec.query<{ local_path: string }>(`SELECT local_path FROM sources WHERE local_path IS NOT NULL AND local_path <> ''`);
  return rows.map(r => r.local_path);
}

/** A source with a local path and its archived flag (`listLocalPathSources`). */
export interface LocalPathSourceRow { id: string; local_path: string; archived: boolean }

/** One source row for request-scoped source resolution, with the brain-wide `default` emptiness flag (`listSourceRoutingRows`). */
export interface SourceRoutingRow { id: string; local_path: string | null; archived: boolean; config: unknown; default_has_pages: boolean }

/** Live page counts of `default` against every other source (`countDefaultSourceSplit`). */
export interface DefaultSourceSplit { defaultPages: number; nonDefaultPages: number; nonDefaultSources: number }

/**
 * Sources that have a local path, with `archived`, in no particular order. Unscoped on master (source resolution
 * tier 4 read it through `executeRaw`). Throws on a brain older than the `archived` column; the caller falls back.
 */
export async function listLocalPathSources(exec: LegacyUnscopedRead): Promise<LocalPathSourceRow[]> {
  return exec.executeRaw<LocalPathSourceRow>(`SELECT id, local_path, archived FROM sources WHERE local_path IS NOT NULL`);
}

/**
 * Every source row ordered by id, each carrying whether `default` holds a live page, in one statement (the request
 * config snapshot's `sources` read, #7147). Unscoped on master.
 */
export async function listSourceRoutingRows(exec: LegacyUnscopedRead): Promise<SourceRoutingRow[]> {
  return exec.executeRaw<SourceRoutingRow>(
    `SELECT id, local_path, archived, config, EXISTS (SELECT 1 FROM pages WHERE source_id = 'default' AND deleted_at IS NULL) AS default_has_pages FROM sources ORDER BY id`,
  );
}

/**
 * Live pages in `default`, live pages elsewhere, and the number of non-default sources holding a live page (the
 * default-write guard). Soft-deleted pages are left out. Unscoped on master.
 */
export async function countDefaultSourceSplit(exec: LegacyUnscopedRead): Promise<DefaultSourceSplit> {
  const rows = await exec.executeRaw<{
    default_pages: number | string | bigint | null;
    non_default_pages: number | string | bigint | null;
    non_default_sources: number | string | bigint | null;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN source_id = 'default' THEN 1 ELSE 0 END), 0) AS default_pages,
       COALESCE(SUM(CASE WHEN source_id <> 'default' THEN 1 ELSE 0 END), 0) AS non_default_pages,
       COUNT(DISTINCT source_id) FILTER (WHERE source_id <> 'default') AS non_default_sources
     FROM pages
     WHERE deleted_at IS NULL`,
  );
  const r = rows[0];
  return {
    defaultPages: Number(r?.default_pages) || 0,
    nonDefaultPages: Number(r?.non_default_pages) || 0,
    nonDefaultSources: Number(r?.non_default_sources) || 0,
  };
}

/** Pages of one source (`SELECT COUNT(*)::int AS n FROM pages WHERE source_id=$1`); soft-deleted pages count only with `includeDeleted`. Unscoped on master. */
export async function countSourcePages(exec: LegacyUnscopedRead, sourceId: string, opts?: { includeDeleted?: boolean }): Promise<number> {
  const sql = opts?.includeDeleted === true
    ? 'SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1'
    : 'SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL';
  const [row] = await exec.executeRaw<{ n: number }>(sql, [sourceId]);
  return Number(row?.n ?? 0);
}

/** The columns `insertSource` writes; the table fills the rest with its defaults. */
export interface SourceInsert { id: string; name: string; local_path: string | null; config: Record<string, unknown> }

/**
 * Inserts one source row. A taken id or name throws the table's unique-key error and writes nothing. The config binds
 * through jsonbParam, never a JSON.stringify'd string into `::jsonb` (postgres.js would double-encode it).
 */
export async function insertSource(exec: SqlExecutor, row: SourceInsert): Promise<void> {
  await exec.run(sqlFragment`
    INSERT INTO sources (id, name, local_path, config)
         VALUES (${row.id}, ${row.name}, ${row.local_path}, ${jsonbParam(row.config)})
  `);
}
