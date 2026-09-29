import type { BrainEngine, SourceRow } from './engine.ts';

export function mapStoredSourceRow(row: Record<string, unknown>): SourceRow {
  const config = typeof row.config === 'string'
    ? JSON.parse(row.config) as Record<string, unknown>
    : ((row.config as Record<string, unknown> | null) ?? {});
  const date = (value: unknown) => value ? new Date(value as string | Date) : null;
  return {
    id: row.id as string,
    incarnation: row.incarnation as string,
    name: (row.name as string | null) ?? null,
    local_path: (row.local_path as string | null) ?? null,
    last_sync_at: date(row.last_sync_at),
    config,
    cycle_state_exists: row.cycle_state_exists === true,
    last_source_cycle_at: date(row.last_source_cycle_at),
    last_full_cycle_at: date(row.last_full_cycle_at),
  };
}

export interface SourceCycleTimestamps {
  lastSourceCycleAt: Date | null;
  lastFullCycleAt: Date | null;
}

function validDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function readRawFullCycleAt(source: SourceRow): unknown {
  return source.cycle_state_exists
    ? source.last_full_cycle_at
    : source.config?.last_full_cycle_at;
}

/** Current-incarnation rows are authoritative; config is fallback only until one exists. */
export function readSourceCycleTimestamps(source: SourceRow): SourceCycleTimestamps {
  if (source.cycle_state_exists) {
    return {
      lastSourceCycleAt: validDate(source.last_source_cycle_at),
      lastFullCycleAt: validDate(source.last_full_cycle_at),
    };
  }
  const config = source.config ?? {};
  return {
    lastSourceCycleAt: validDate(config.last_source_cycle_at),
    lastFullCycleAt: validDate(config.last_full_cycle_at),
  };
}

/** Capture the incarnation before cycle work; deleted/recreated rows cannot inherit its stamp. */
export async function captureSourceIncarnation(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ incarnation: string }>(
    'SELECT incarnation FROM sources WHERE id = $1 AND archived IS NOT TRUE',
    [sourceId],
  );
  return rows[0]?.incarnation ?? null;
}

/** Stamp only if the same source incarnation is still current and active. */
export async function writeSourceCycleTimestamps(
  engine: BrainEngine,
  sourceId: string,
  incarnation: string,
  at: string,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ source_id: string }>(
    `INSERT INTO source_cycle_state
       (source_id, source_incarnation, last_source_cycle_at, last_full_cycle_at, updated_at)
     SELECT s.id, s.incarnation, $3::timestamptz, $3::timestamptz, $3::timestamptz
       FROM sources s
      WHERE s.id = $1 AND s.incarnation = $2::uuid AND s.archived IS NOT TRUE
     ON CONFLICT (source_id, source_incarnation) DO UPDATE
       SET last_source_cycle_at = CASE
             WHEN EXCLUDED.last_source_cycle_at IS NOT NULL
               AND (source_cycle_state.last_source_cycle_at IS NULL
                    OR EXCLUDED.last_source_cycle_at > source_cycle_state.last_source_cycle_at)
             THEN EXCLUDED.last_source_cycle_at ELSE source_cycle_state.last_source_cycle_at END,
           last_full_cycle_at = CASE
             WHEN EXCLUDED.last_full_cycle_at IS NOT NULL
               AND (source_cycle_state.last_full_cycle_at IS NULL
                    OR EXCLUDED.last_full_cycle_at > source_cycle_state.last_full_cycle_at)
             THEN EXCLUDED.last_full_cycle_at ELSE source_cycle_state.last_full_cycle_at END,
           updated_at = CASE
             WHEN EXCLUDED.updated_at > source_cycle_state.updated_at
             THEN EXCLUDED.updated_at ELSE source_cycle_state.updated_at END
     RETURNING source_id`,
    [sourceId, incarnation, at],
  );
  return rows.length > 0;
}
