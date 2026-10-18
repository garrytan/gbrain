import type { BrainEngine } from '../../src/core/engine.ts';

/**
 * #6948: duplicate-origin twins exist only on brains written before `pages_live_origin_key` (the index stays pending
 * while they do), so a fixture that seeds twins drops it first, as such a brain is.
 */
export async function dropOriginIndex(engine: Pick<BrainEngine, 'executeRaw'>): Promise<void> {
  await engine.executeRaw('DROP INDEX IF EXISTS pages_live_origin_key');
}
