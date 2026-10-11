import { spawn } from './spawn.ts';

export function startWorker(cli: string): void {
  spawn(cli, ['jobs', 'work'], { stdio: 'inherit', windowsHide: false });
}
