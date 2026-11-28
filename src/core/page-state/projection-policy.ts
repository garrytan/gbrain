import type { BrainEngine } from '../engine.ts';
import { withTransactionSettings } from '../persistence/context.ts';
import { HISTORICAL_PROJECTION_HELD_SQL, PROJECTION_OVERRIDE_SETTING } from './projection-policy-sql.ts';

/** The override is scoped to the enclosing transaction, including nested savepoints. */
export function projectionTransaction<T>(engine: BrainEngine, override: boolean | undefined, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async tx => {
    if (override !== false) return run(tx);
    return withTransactionSettings(tx, [PROJECTION_OVERRIDE_SETTING], () => ['false'], () => run(tx));
  });
}

/** Re-check under the page guard before replacing historical derived rows. */
export async function pageProjectionHeld(engine: Pick<BrainEngine, 'executeRaw'>, ref: { sourceId: string; slug: string }, override?: boolean): Promise<boolean> {
  if (override === false) return false;
  const [row] = await engine.executeRaw<{ held: boolean }>(`SELECT ${HISTORICAL_PROJECTION_HELD_SQL} AS held
    FROM pages p JOIN sources s ON s.id=p.source_id
    LEFT JOIN page_projection_jobs j ON j.source_incarnation=s.incarnation AND j.slug=p.slug
    WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL
      AND ($3::boolean OR COALESCE((SELECT value='true' FROM config WHERE key='embed.current_projections_only'),false))`,
  [ref.sourceId, ref.slug, override === true]);
  return row?.held === true;
}

export class HistoricalProjectionHeldError extends Error {
  readonly code = 'historical_projection_held';
  constructor(sourceId: string, slug: string) {
    super(`Historical projection ${sourceId}:${slug} is held; the owner can authorize a rebuild with --no-current-projections-only.`);
    this.name = 'HistoricalProjectionHeldError';
  }
}
