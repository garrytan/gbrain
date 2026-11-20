/**
 * A source's own contextual-retrieval mode (`sources.contextual_retrieval_mode`), written by `gbrain sources
 * set-cr-mode` (commands/sources.ts runSetCrMode), as one typed engine member every engine serves:
 *
 * - `setSourceContextualMode(sourceId, mode)`: sets the mode, or clears it to NULL (the source falls through to the
 *   global mode) when `mode` is null. Answers whether the source exists; an unknown id writes nothing.
 *
 * One statement checks and writes, so a source removed between a separate check and the write cannot read as set.
 * The mode is read back by `getSource` and the synopsis tier (engine-sql/synopsis-tier.ts).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

export const SET_SOURCE_CONTEXTUAL_MODE_SQL = `UPDATE sources SET contextual_retrieval_mode = $1 WHERE id = $2 RETURNING id`;

export async function setSourceContextualMode(tx: Raw, sourceId: string, mode: string | null): Promise<boolean> {
  const rows = await tx.executeRaw<{ id: string }>(SET_SOURCE_CONTEXTUAL_MODE_SQL, [mode, sourceId]);
  return rows.length > 0;
}
