import type { BrainEngine } from '../engine.ts';
import { isLocalConfigurationError } from './configuration-error.ts';
import { rowToMinionJob, type MinionJob } from './types.ts';

/** UPDATE ... RETURNING can commit before its reply is lost. Recover only the still-live claim of this poll. */
export async function readActiveClaim(engine: BrainEngine, queue: string, lockToken: string): Promise<MinionJob | null> {
  try {
    const [row] = await engine.executeRawDirect<Record<string, unknown>>(
      `SELECT * FROM minion_jobs
       WHERE queue = $1 AND status = 'active' AND lock_token = $2 AND lock_until > now()
       LIMIT 1`,
      [queue, lockToken],
    );
    return row ? rowToMinionJob(row) : null;
  } catch (error) {
    if (isLocalConfigurationError(error)) throw error;
    console.error('[worker] could not confirm the claim after connection loss; normal lease recovery remains active');
    return null;
  }
}
