/**
 * State 2 of a swap run: the database-enforced write fence on the primary, through graduation custody
 * (graduation-schema.ts). The primary records a `persistence_graduation` source row for the run, and the
 * `gbrain_graduation_fence` statement trigger goes on every table, `ENABLE ALWAYS`: every write is refused unless its
 * transaction carries the run (`SET LOCAL gbrain.graduation_run`). The fence stays after cutover and across restarts;
 * only the run (and later the reverse follower) writes through it.
 *
 * Before the fence, the graduation drain finishes this host's admitted requests, so nothing already acknowledged is
 * left behind it.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { drainForGraduation } from '../persistence/graduation-drain.ts';
import {
  GRADUATION_FENCE_TRIGGER, graduationFenceStatus, readGraduationRow, setSourceState, withGraduationRun,
} from '../persistence/graduation-schema.ts';
import type { GraduationBlocker } from '../persistence/engine-graduation.types.ts';

const FENCED_TABLES_SQL = `SELECT c.oid AS relid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind IN ('r','p') AND NOT c.relispartition`;

export interface FenceResult {
  drained: readonly string[];
  tables: number;
}

/** Thrown when the drain leaves a blocker it cannot clear (a request that needs the user, a writer held elsewhere). */
export class DrainBlockedError extends Error {
  constructor(readonly blockers: readonly GraduationBlocker[]) {
    super(`the graduation drain left ${blockers.length} blocker(s): ${blockers.map(b => b.kind).join(', ')}`);
  }
}

/**
 * Drains, records the source row of `runId` and installs the fence on every table. Idempotent for the same run: a
 * resume repairs a missing trigger and keeps the row.
 */
export async function fencePrimary(primary: BrainEngine, runId: string, opts: { hostId: string; config: GBrainConfig; drainTimeoutMs?: number }): Promise<FenceResult> {
  const row = await readGraduationRow(primary);
  let drained: readonly string[] = [];
  if (!row || row.run_id !== runId) {
    const result = await drainForGraduation(primary, { timeoutMs: opts.drainTimeoutMs ?? 120_000, hostId: opts.hostId, config: opts.config });
    if (result.blockers.length) throw new DrainBlockedError(result.blockers);
    drained = result.drained;
    await primary.transaction(async tx => { await setSourceState(tx, runId, 'quiesced'); });
  }
  await withGraduationRun(primary, runId, async tx => {
    await tx.executeRaw(`DO $install$ DECLARE r record; BEGIN
      FOR r IN ${FENCED_TABLES_SQL} LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = r.relid AND t.tgname = '${GRADUATION_FENCE_TRIGGER}') THEN
          EXECUTE format('CREATE TRIGGER ${GRADUATION_FENCE_TRIGGER} BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION gbrain_graduation_fence()', r.relname);
        END IF;
        EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER ${GRADUATION_FENCE_TRIGGER}', r.relname);
      END LOOP; END $install$`);
  });
  const status = await graduationFenceStatus(primary);
  if (status.unfenced.length) throw new Error(`the write fence is missing on ${status.unfenced.length} table(s)`);
  return { drained, tables: status.tables };
}

/** Whether the primary is fenced for `runId`: its source row names the run and every table has the fence. */
export async function primaryFenced(primary: BrainEngine, runId: string): Promise<boolean> {
  const row = await readGraduationRow(primary);
  if (!row || row.role !== 'source' || row.run_id !== runId) return false;
  return (await graduationFenceStatus(primary)).unfenced.length === 0;
}

/** Marks the source row `cutover` once authority has moved (the fence stays). */
export async function markPrimaryCutover(primary: BrainEngine, runId: string): Promise<void> {
  await withGraduationRun(primary, runId, async tx => {
    const row = await readGraduationRow(tx, { forUpdate: true });
    if (row?.state === 'cutover') return;
    await setSourceState(tx, runId, 'cutover');
  });
}
