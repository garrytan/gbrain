import * as childProcess from 'node:child_process';

export type { ChildProcess } from 'node:child_process';
export const spawn = childProcess.spawn;
export const bunSpawn = Bun.spawn;
