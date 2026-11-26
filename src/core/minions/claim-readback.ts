import type { BrainEngine } from '../engine.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { isLocalConfigurationError } from './configuration-error.ts';
import type { MinionJob } from './types.ts';

/** UPDATE ... RETURNING can commit before its reply is lost. Recover only the still-live claim of this poll. */
export async function readActiveClaim(engine: BrainEngine, queue: string, lockToken: string): Promise<MinionJob | null> {
  try {
    return await engine.findLiveMinionClaim(queue, lockToken);
  } catch (error) {
    rethrowCapabilityRefusal(error);
    if (isLocalConfigurationError(error)) throw error;
    console.error('[worker] could not confirm the claim after connection loss; normal lease recovery remains active');
    return null;
  }
}
