import type { SyncRun } from './sync-run.ts';
import { bank } from './sync-run.ts';
export async function phase(run: SyncRun): Promise<number> {
  const { failedFiles } = run; // readonly reference: allowed
  await Promise.resolve();
  if (run.checkpointDead) return failedFiles.length;
  run.chunksCreated += 1; // mutable, not a checkpoint field: allowed
  bank(run, 1);
  return run.bankedFiles;
}
