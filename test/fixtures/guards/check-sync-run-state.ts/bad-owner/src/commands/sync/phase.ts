import type { SyncRun } from './sync-run.ts';
export function phase(run: SyncRun): void {
  run.checkpointDead = true; // checkpoint state written outside its owner
}
