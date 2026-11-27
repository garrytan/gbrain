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
import { ORIGIN_INDEX_NAME, type OriginIndexState, type OriginTwinCount } from '../engine-sql/repair-page-reads.ts';

export const ORIGIN_INDEX = {
  name: ORIGIN_INDEX_NAME,
  table: 'pages',
  sql: 'CREATE UNIQUE INDEX IF NOT EXISTS pages_live_origin_key ON pages (source_id, source_path) WHERE deleted_at IS NULL AND source_path IS NOT NULL',
};

/** Live twin groups (same stored origin) per source, at most `limit` sources (engine-sql/repair-page-reads.ts). */
export function originTwinCounts(engine: Pick<BrainEngine, 'listOriginTwinCounts'>, limit = 50): Promise<OriginTwinCount[]> {
  return engine.listOriginTwinCounts(limit);
}

export type { OriginIndexState };

/** The index's state (engine-sql/repair-page-reads.ts). */
export function originIndexState(engine: Pick<BrainEngine, 'readOriginIndexState'>): Promise<OriginIndexState> {
  return engine.readOriginIndexState();
}

export const originTwinsRepairCommand = (sourceId: string) => `gbrain repair origin-twins --source ${sourceId}`;

export type OriginIndexOutcome = { state: Exclude<OnlineIndexOutcome, 'building'> | 'building' } | { state: 'pending'; sources: OriginTwinCount[] };

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
