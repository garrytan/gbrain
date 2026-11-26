/**
 * `brain_ref`: a short, one-way reference to one brain, for naming that brain in a reviewed policy (the engine swap's
 * dated readiness override) without ever printing its persistence identity.
 *
 * The input is `persistence_brain.brain_id`, a random version-4 UUID the schema creates once per brain. The output is
 * the first 64 bits of a domain-separated SHA-256 of it. A digest cannot be inverted, and guessing the input means
 * searching 122 random bits, so a printed `brain_ref` reveals nothing usable about the identity. `gbrain engine status
 * --json --probe` prints it; nothing in gbrain prints the identity itself.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';

const DOMAIN = 'gbrain-engine-swap-brain-ref-v1';

/** The `brain_ref` of the brain whose `persistence_brain.brain_id` is `brainId` (16 lowercase hex characters). */
export function brainRefFor(brainId: string): string {
  return createHash('sha256').update(`${DOMAIN}\0${brainId}`).digest('hex').slice(0, 16);
}

/** The `brain_ref` of the open brain, or null when its schema has no persistence identity yet. */
export async function readBrainRef(engine: Pick<BrainEngine, 'readPersistenceBrainId'>): Promise<string | null> {
  const id = await engine.readPersistenceBrainId();
  return id ? brainRefFor(id) : null;
}
