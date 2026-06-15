import type { BrainEngine } from './engine.ts';
import { drainAllBackgroundWorkForCliExit } from './background-work.ts';

/**
 * CLI-EXIT-ONLY: drain every fire-and-forget DB-write sink before disconnecting
 * the engine. This keeps the dream owner-disconnect and CLI fall-through paths
 * on the same contract as op dispatch.
 */
export async function disconnectEngineForCliExit(
  engine: BrainEngine,
  opts?: { timeoutMs?: number },
): Promise<void> {
  await drainAllBackgroundWorkForCliExit(opts);
  await engine.disconnect();
}
