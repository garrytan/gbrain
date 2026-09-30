export interface SyncRun {
  readonly failedFiles: string[];
  /** @checkpoint */
  bankedFiles: number;
  /** @checkpoint */
  checkpointDead: boolean;
  chunksCreated: number;
}
export function createSyncRun(): SyncRun {
  return { failedFiles: [], bankedFiles: 0, checkpointDead: false, chunksCreated: 0 };
}
export function bank(run: SyncRun, n: number): void {
  run.bankedFiles += n;
}
