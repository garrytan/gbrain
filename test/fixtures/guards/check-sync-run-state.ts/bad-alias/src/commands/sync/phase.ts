import { createSyncRun } from './sync-run.ts';
export async function phase(): Promise<boolean> {
  const state = createSyncRun();
  const dead = state.checkpointDead; // snapshot of a mutable field
  await Promise.resolve();
  return dead;
}
