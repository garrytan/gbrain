import type { SyncRun } from '../sync-run.ts';
export async function imports({ checkpointDead }: SyncRun): Promise<boolean> {
  await Promise.resolve();
  return checkpointDead;
}
