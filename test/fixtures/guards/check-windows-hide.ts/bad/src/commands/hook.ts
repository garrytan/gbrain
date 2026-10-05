import { spawn } from 'node:child_process';

export function spawnDetachedPush(exec: string, argv: string[]): void {
  spawn(exec, argv, { detached: true, stdio: 'ignore' }).unref();
}
