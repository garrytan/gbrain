import type { SpawnOptions } from 'node:child_process';
import { bunSpawn, spawn, type ChildProcess } from './spawn.ts';

export function startWorker(cli: string, options: SpawnOptions): ChildProcess {
  return spawn(cli, ['jobs', 'work'], { ...options, detached: true, windowsHide: true });
}

export function probe(argv: string[]): ReturnType<typeof Bun.spawn> {
  return bunSpawn(argv, { stdout: 'pipe' });
}
