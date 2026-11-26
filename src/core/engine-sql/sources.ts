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
import { renderFragment } from './fragment.ts';
import { ANY_OWNER_ONLY_SQL, OWNER_ONLY_LINEAGE_PRESENT_SQL } from '../access/owner-only.ts';

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

/** The engine's own executeRaw (or a persistence view's), so access/owner-only.ts runs the same statement on either. */
export interface OwnerOnlyRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/**
 * Does the brain hold an owner-only source, archived ones included, or (with `lineage` on, the v320 lineage function
 * the schema carries, see access/owner-only.ts `ownerOnlyLineageReadable`) a row derived from a removed one? No row counts as yes (fail closed).
 */
export async function readOwnerOnlySourcesPresent(exec: OwnerOnlyRead, lineage: boolean = false): Promise<boolean> {
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(lineage ? OWNER_ONLY_LINEAGE_PRESENT_SQL : ANY_OWNER_ONLY_SQL)} AS present`);
  const [row] = await exec.executeRaw<{ present: boolean }>(text, params);
  return row?.present !== false;
}

/** One source's raw `config` for the owner-only test, or null when the source is missing (`sourceIsOwnerOnly`). */
export async function readOwnerOnlySourceConfig(exec: OwnerOnlyRead, sourceId: string): Promise<{ config: unknown } | null> {
  const rows = await exec.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [sourceId]);
  return rows[0] ?? null;
}
