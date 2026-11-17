/**
 * #6948: the database invariant behind origin twins: one live page per recorded origin, a partial unique index
 * `pages_live_origin_key` on (source_id, source_path) over live pages that record a file. It is built online only
 * when the brain holds no live twins (the migration, or `gbrain repair origin-twins --apply` once the last group is
 * resolved); with twins it is left pending and doctor names the repair, so no upgrade fails or rewrites data.
 * The index covers the stored spelling; the legacy `<scope>/<origin>` spelling of a scoped source-root source is
 * refused by the writer guard and reported by doctor and the repair.
 */
import type { BrainEngine } from '../engine.ts';
import { buildIndexOnline, type OnlineIndexOutcome } from '../schema-migrations/helpers.ts';

export const ORIGIN_INDEX = {
  name: 'pages_live_origin_key',
  table: 'pages',
  sql: 'CREATE UNIQUE INDEX IF NOT EXISTS pages_live_origin_key ON pages (source_id, source_path) WHERE deleted_at IS NULL AND source_path IS NOT NULL',
};

/** Live twin groups (same stored origin) per source, at most `limit` sources. */
export async function originTwinCounts(engine: Pick<BrainEngine, 'executeRaw'>, limit = 50): Promise<Array<{ source_id: string; groups: number; twins: number }>> {
  const rows = await engine.executeRaw<{ source_id: string; groups: number; twins: number }>(`SELECT source_id, count(*)::int AS groups, (sum(n) - count(*))::int AS twins
    FROM (SELECT source_id, count(*) AS n FROM pages WHERE deleted_at IS NULL AND source_path IS NOT NULL GROUP BY source_id, source_path HAVING count(*) > 1) g
    GROUP BY source_id ORDER BY source_id LIMIT ${Math.max(1, Math.floor(limit))}`);
  return rows.map(row => ({ source_id: row.source_id, groups: Number(row.groups), twins: Number(row.twins) }));
}

export type OriginIndexState = 'present' | 'missing' | 'invalid';

export async function originIndexState(engine: Pick<BrainEngine, 'executeRaw' | 'kind'>): Promise<OriginIndexState> {
  if (engine.kind !== 'postgres') {
    const [row] = await engine.executeRaw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [ORIGIN_INDEX.name]);
    return row?.present ? 'present' : 'missing';
  }
  const [row] = await engine.executeRaw<{ valid: boolean }>('SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)', [ORIGIN_INDEX.name]);
  return !row ? 'missing' : row.valid ? 'present' : 'invalid';
}

export const originTwinsRepairCommand = (sourceId: string) => `gbrain repair origin-twins --source ${sourceId}`;

export type OriginIndexOutcome = { state: Exclude<OnlineIndexOutcome, 'building'> | 'building' } | { state: 'pending'; sources: Array<{ source_id: string; groups: number; twins: number }> };

/**
 * Builds the index when no live twins exist (online, CONCURRENTLY on Postgres); otherwise writes nothing and returns
 * the sources that still hold twins. A twin written between the check and a concurrent build fails the build: the
 * INVALID remnant (which would still enforce uniqueness) is dropped and the index stays pending. Never throws for twins.
 */
export async function buildOriginIndexIfClean(engine: BrainEngine, version: number, notice?: (line: string) => void): Promise<OriginIndexOutcome> {
  if (await originIndexState(engine) === 'present') return { state: 'present' };
  const sources = await originTwinCounts(engine);
  if (sources.length) return { state: 'pending', sources };
  try {
    return { state: await buildIndexOnline(engine, version, ORIGIN_INDEX, { notice, rebuild: 'gbrain repair origin-twins --source <id> --apply' }) };
  } catch (error) {
    const again = await originTwinCounts(engine);
    if (!again.length) throw error;
    if (engine.kind === 'postgres') await engine.withReservedConnection(conn => conn.executeRaw(`DROP INDEX CONCURRENTLY IF EXISTS ${ORIGIN_INDEX.name}`), { selfContained: true });
    else await engine.executeRaw(`DROP INDEX IF EXISTS ${ORIGIN_INDEX.name}`);
    return { state: 'pending', sources: again };
  }
}
