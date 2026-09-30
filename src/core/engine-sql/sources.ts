/**
 * Sources: one SQL implementation for both engines (refactor wave 1,
 * W1-extended). Statement text is PostgresEngine's master text (SQL-text
 * golden `sql-text/sources.json`); PGLite runs the same statements
 * (docs/designs/refactor-wave-1/w1-inventory.md). `listAllSources` was
 * unscoped on master (EO4 inventory), so it takes `LegacyUnscopedRead`.
 */
import type { SourceRow } from '../engine.ts';
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
    // dispatch jobs that would fall back to the global sync.repo_path.
    const includeArchived = opts?.includeArchived === true;
    const localPathOnly = opts?.localPathOnly === true;
    const { rows } = await exec.run(sqlFragment`
      SELECT id, name, local_path, last_sync_at, config
        FROM sources
       WHERE (${includeArchived} OR archived IS NOT TRUE)
         AND (${!localPathOnly} OR local_path IS NOT NULL)
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
    // the whole UPDATE. Postgres has no `try_cast`, so we gate the cast with
    // the SQL `IS JSON` predicate (Postgres 16+): parseable inner text is
    // double-encoded config and gets parsed; unparseable text falls back to `{}`.
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
