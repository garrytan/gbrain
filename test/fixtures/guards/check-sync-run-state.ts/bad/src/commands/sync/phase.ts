import type { SyncRun } from './sync-run.ts';
export async function phase(run: SyncRun): Promise<number> {
  const { bankedFiles } = run; // snapshot of a mutable field
  await Promise.resolve();
  return bankedFiles;
}
